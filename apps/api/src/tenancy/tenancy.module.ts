import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AccessGuard } from "./access.js";
import { AccessResolver } from "./access.resolver.js";
import { TenantDb } from "./tenant-db.js";

/** Компании, сотрудники и права. Проверка доступа подключена ко всем адресам API. */
@Global()
@Module({
  providers: [TenantDb, AccessResolver, { provide: APP_GUARD, useClass: AccessGuard }],
  exports: [TenantDb],
})
export class TenancyModule {}
