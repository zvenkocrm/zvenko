import { Global, Module } from "@nestjs/common";
import { AuthPort, DenyAllAuth } from "./auth.port.js";

/** Модуль входа. Адаптер Better Auth (ADR-0006) заменит DenyAllAuth. */
@Global()
@Module({
  providers: [{ provide: AuthPort, useClass: DenyAllAuth }],
  exports: [AuthPort],
})
export class IdentityModule {}
