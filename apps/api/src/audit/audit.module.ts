import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service.js";

/** Журнал аудита (F-AUD): запись доступна всем модулям, которые меняют важное. */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
