import { type BeforeApplicationShutdown, Inject, Injectable } from "@nestjs/common";
import type { Logger } from "pino";
import { LOGGER } from "../config/config.module.js";
import { type AccountEvent, AuthEvents, type AuthRequestSource } from "../identity/auth-events.js";
import { AccessResolver } from "../tenancy/access.resolver.js";
import { TenantDb } from "../tenancy/tenant-db.js";
import { TenantDirectory } from "../tenancy/tenant-directory.js";
import { type AuditAction, AuditService, type AuditSource, cleanSource } from "./audit.service.js";

/** Изменения учётной записи, которые делает сам пользователь. */
const USER_CHANGES = {
  two_factor_enabled: "auth.two_factor_enabled",
  two_factor_disabled: "auth.two_factor_disabled",
  backup_codes_generated: "auth.backup_codes_generated",
  password_changed: "auth.password_changed",
} as const satisfies Record<string, AuditAction>;

/**
 * События входа в журналы аудита компаний (F-AUD-01, D30):
 * - вход и выход — в журнал компании, куда вошёл: по адресу сайта или выбранной в сессии;
 *   на общем адресе входа в компанию ещё нет — он запишется при выборе компании;
 * - неудачные попытки, блокировка, 2FA, пароль, завершение сессий — в журналы всех
 *   компаний пользователя: учётная запись одна, её взлом угрожает каждой.
 */
@Injectable()
export class AuthAuditRecorder extends AuthEvents implements BeforeApplicationShutdown {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly audit: AuditService,
    private readonly directory: TenantDirectory,
    private readonly resolver: AccessResolver,
    private readonly tenantDb: TenantDb,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    super();
  }

  async signedIn(
    event: { readonly userId: string; readonly sessionId: string },
    source: AuthRequestSource,
  ): Promise<void> {
    try {
      await this.recordInCompany(event.userId, null, "auth.sign_in", event.sessionId, source);
    } catch (error) {
      this.logger.error(
        { err: error, requestId: source.requestId },
        "вход не записан в журнал аудита — вход отменён",
      );
      throw error;
    }
  }

  record(event: AccountEvent, source: AuthRequestSource): void {
    const write = this.write(event, source).catch((error: unknown) => {
      this.logger.error(
        { err: error, requestId: source.requestId, event: event.type },
        "событие входа не записано в журнал аудита",
      );
    });
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
  }

  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  /** Фоновые записи дописываются до закрытия пулов соединений. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.settled();
  }

  private async write(event: AccountEvent, raw: AuthRequestSource): Promise<void> {
    const source = cleanSource(raw);
    const account = { type: "user", id: event.userId } as const;
    switch (event.type) {
      case "signed_out":
        await this.recordInCompany(
          event.userId,
          event.tenantId,
          "auth.sign_out",
          event.sessionId,
          raw,
        );
        return;
      case "sign_in_failed":
        await this.audit.recordForUser(event.userId, {
          actor: { type: "anonymous" },
          action: "auth.sign_in",
          result: "failure",
          object: account,
          source,
          details: { reason: event.reason },
        });
        return;
      case "account_locked":
        await this.audit.recordForUser(event.userId, {
          actor: { type: "system" },
          action: "auth.account_locked",
          result: "success",
          object: account,
          source,
        });
        return;
      case "sessions_revoked":
        await this.audit.recordForUser(event.userId, {
          actor: account,
          action: "auth.sessions_revoked",
          result: "success",
          object: account,
          source,
          details: { scope: event.scope },
        });
        return;
      case "two_factor_enabled":
      case "two_factor_disabled":
      case "backup_codes_generated":
      case "password_changed":
        await this.audit.recordForUser(event.userId, {
          actor: account,
          action: USER_CHANGES[event.type],
          result: "success",
          object: account,
          source,
        });
    }
  }

  /**
   * Вход или выход — в журнал компании: по адресу сайта, а без поддомена — выбранной
   * в сессии. Только если пользователь в ней работает; иначе писать некуда.
   */
  private async recordInCompany(
    userId: string,
    sessionTenantId: string | null,
    action: AuditAction,
    sessionId: string,
    raw: AuthRequestSource,
  ): Promise<void> {
    const host = raw.host === null ? null : await this.directory.resolve(raw.host);
    const tenantId = host?.kind === "tenant" ? host.tenantId : sessionTenantId;
    if (tenantId === null) return;
    const member = await this.resolver.resolve(userId, tenantId);
    if (!member) return;
    const source: AuditSource = cleanSource(raw);
    await this.tenantDb.transaction(member.context, (tx) =>
      this.audit.record(tx, {
        tenantId,
        actor: { type: "user", id: userId },
        action,
        result: "success",
        object: { type: "session", id: sessionId },
        source,
      }),
    );
  }
}
