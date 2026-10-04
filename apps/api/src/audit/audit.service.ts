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

/**
 * Действия, которые пишутся в журнал компании (F-AUD-01), — с названиями для интерфейса.
 * Список растёт вместе с функциями: вход и 2FA, приглашения, роли, экспорт, настройки.
 */
export const AUDIT_ACTIONS = {
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
 * Источник действия из запроса. IP — тот, что увидел сервер с учётом TRUST_PROXY;
 * если это не адрес (ошибка настройки прокси), он не записывается, а запись не падает.
 */
export function auditSource(request: FastifyRequest): AuditSource {
  const ip = request.ip.split("%")[0] ?? "";
  const userAgent = request.headers["user-agent"];
  return {
    ip: isIP(ip) === 0 ? null : ip,
    userAgent:
      typeof userAgent === "string"
        ? Array.from(userAgent).filter(isPrintable).slice(0, USER_AGENT_MAX_LENGTH).join("")
        : null,
    requestId: request.id,
  };
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
}
