import { Global, Module } from "@nestjs/common";
import { AuthEvents } from "../identity/auth-events.js";
import { AuditService } from "./audit.service.js";
import { AuthAuditRecorder } from "./auth-audit.recorder.js";

/**
 * Журнал аудита (F-AUD): запись доступна всем модулям, которые меняют важное.
 * События входа модуль identity сообщает через AuthEvents — их пишет AuthAuditRecorder.
 */
@Global()
@Module({
  providers: [AuditService, { provide: AuthEvents, useClass: AuthAuditRecorder }],
  exports: [AuditService, AuthEvents],
})
export class AuditModule {}
