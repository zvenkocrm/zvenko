import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Put } from "@nestjs/common";
import { z } from "zod";
import { AuditService, type AuditSource, RequestSource } from "../audit/audit.service.js";
import type { Session } from "../identity/auth.port.js";
import { IdentityService } from "../identity/identity.service.js";
import { CurrentSession, SessionOnly } from "./access.js";
import { AccessResolver } from "./access.resolver.js";
import { TenantDb } from "./tenant-db.js";

const selectTenantSchema = z.object({ tenantId: z.uuid() });

/**
 * Компания сессии (F-AUTH-06). На адресе компании (`neva.zvenko.ru`) она задаётся адресом;
 * здесь её выбирают там, где поддомена нет: в локальной разработке и на общем адресе.
 */
@Controller({ path: "session", version: "1" })
export class SessionController {
  constructor(
    private readonly resolver: AccessResolver,
    private readonly identity: IdentityService,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
  ) {}

  /**
   * Только своя компания. Чужая неотличима от несуществующей — 404 (SEC-05).
   * Вход в компанию записывается в её журнал (F-AUD-01) — до выбора: без записи нет действия.
   */
  @Put("tenant")
  @SessionOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async selectTenant(
    @CurrentSession() session: Session,
    @Body({ schema: selectTenantSchema }) body: z.infer<typeof selectTenantSchema>,
    @RequestSource() source: AuditSource,
  ): Promise<void> {
    const member = await this.resolver.resolve(session.userId, body.tenantId);
    if (!member) throw new NotFoundException();
    await this.tenantDb.transaction(member.context, (tx) =>
      this.audit.record(tx, {
        tenantId: body.tenantId,
        actor: { type: "user", id: session.userId },
        action: "session.tenant_selected",
        result: "success",
        object: { type: "session", id: session.sessionId },
        source,
      }),
    );
    await this.identity.setActiveTenant(session.sessionId, body.tenantId);
  }
}
