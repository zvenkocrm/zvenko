import { isIP } from "node:net";
import { createParamDecorator, type ExecutionContext, Injectable } from "@nestjs/common";
import {
  type AuditActor,
  type AuditJson,
  type AuditResult,
  appendAuditEntry,
  type Transaction,
} from "@zvenko/db";
import type { FastifyRequest } from "fastify";
import { MembershipDirectory } from "../tenancy/membership-directory.js";
import { TenantDb } from "../tenancy/tenant-db.js";

/**
 * Действия, которые пишутся в журнал компании (F-AUD-01), — с названиями для интерфейса.
 * Неудачная попытка входа — `auth.sign_in` с результатом `failure`.
 * Список растёт вместе с функциями: приглашения, роли, экспорт, настройки.
 */
export const AUDIT_ACTIONS = {
  "auth.sign_in": "Вход",
  "auth.sign_out": "Выход",
  "auth.account_locked": "Аккаунт временно заблокирован",
  "auth.two_factor_enabled": "2FA включена",
  "auth.two_factor_disabled": "2FA выключена",
  "auth.backup_codes_generated": "Новые резервные коды 2FA",
  "auth.password_changed": "Пароль изменён",
  "auth.sessions_revoked": "Сессии завершены",
  "session.tenant_selected": "Вход в компанию",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** Откуда пришло действие (F-AUD-02): IP, устройство и ID запроса для поиска в логах. */
export interface AuditSource {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}

export interface AuditRecord {
  readonly tenantId: string;
  readonly actor: AuditActor;
  readonly action: AuditAction;
  readonly result: AuditResult;
  readonly object?: { readonly type: string; readonly id: string };
  readonly source: AuditSource;
  /** Подробности действия — без секретов и без лишних ПДн. */
  readonly details?: Readonly<Record<string, AuditJson>>;
}

const USER_AGENT_MAX_LENGTH = 512;

/** Формат ID запроса, который принимает журнал (как в request-id.ts). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Управляющие символы и символы смены направления текста из заголовка в журнал не попадают:
 * они могли бы исказить строку при показе или в выгрузке.
 */
function isPrintable(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return !(
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * Источник действия в том виде, в каком его принимает журнал. IP — только адрес: если это
 * не адрес (ошибка настройки прокси), он не записывается, а запись не падает. User-Agent —
 * без управляющих символов и не длиннее 512 символов.
 */
export function cleanSource(raw: {
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
}): AuditSource {
  const ip = raw.ip?.split("%")[0] ?? "";
  return {
    ip: isIP(ip) === 0 ? null : ip,
    userAgent:
      raw.userAgent === null
        ? null
        : Array.from(raw.userAgent).filter(isPrintable).slice(0, USER_AGENT_MAX_LENGTH).join(""),
    requestId: raw.requestId !== null && SAFE_REQUEST_ID.test(raw.requestId) ? raw.requestId : null,
  };
}

/** Источник действия из запроса. IP — тот, что увидел сервер с учётом TRUST_PROXY. */
export function auditSource(request: FastifyRequest): AuditSource {
  const userAgent = request.headers["user-agent"];
  return cleanSource({
    ip: request.ip,
    userAgent: typeof userAgent === "string" ? userAgent : null,
    requestId: request.id,
  });
}

/** Источник действия текущего запроса — параметр обработчика. */
export const RequestSource = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuditSource =>
    auditSource(context.switchToHttp().getRequest<FastifyRequest>()),
);

/**
 * Журнал аудита компании (F-AUD, SEC-07). Записи только дописываются; номер, время
 * и цепочку хэшей ставит БД.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly memberships: MembershipDirectory,
  ) {}

  /**
   * Дописывает запись в транзакции действия — запись и действие фиксируются вместе.
   * Запись держит очередь журнала компании до конца транзакции, поэтому она — последний шаг.
   * Если действие происходит вне этой БД, запись делается до него: без записи нет действия.
   */
  async record(tx: Transaction, record: AuditRecord): Promise<void> {
    await appendAuditEntry(tx, {
      tenantId: record.tenantId,
      actor: record.actor,
      action: record.action,
      result: record.result,
      object: record.object,
      ip: record.source.ip,
      userAgent: record.source.userAgent,
      requestId: record.source.requestId,
      details: record.details,
    });
  }

  /**
   * Событие учётной записи — в журналы всех компаний пользователя (D30). У каждой компании
   * своя транзакция: очереди журналов разных компаний не ждут друг друга. Сбой в одной
   * компании не мешает записи в остальные — ошибки возвращаются вместе в конце.
   */
  async recordForUser(userId: string, record: Omit<AuditRecord, "tenantId">): Promise<void> {
    const tenantIds = await this.memberships.tenantsOf(userId);
    const results = await Promise.allSettled(
      tenantIds.map((tenantId) =>
        this.tenantDb.forUser(tenantId, userId, (tx) => this.record(tx, { ...record, tenantId })),
      ),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason as unknown] : [],
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, "событие не записано в журналы части компаний");
    }
  }
}
