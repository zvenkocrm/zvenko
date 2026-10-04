import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AccessGuard } from "./access.js";
import { AccessResolver } from "./access.resolver.js";
import { MembershipDirectory } from "./membership-directory.js";
import { SessionController } from "./session.controller.js";
import { TenantDb } from "./tenant-db.js";
import { TenantDirectory } from "./tenant-directory.js";

/** Компании, сотрудники и права. Проверка доступа подключена ко всем адресам API. */
@Global()
@Module({
  controllers: [SessionController],
  providers: [
    TenantDb,
    AccessResolver,
    TenantDirectory,
    MembershipDirectory,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [TenantDb, AccessResolver, TenantDirectory, MembershipDirectory],
})
export class TenancyModule {}
