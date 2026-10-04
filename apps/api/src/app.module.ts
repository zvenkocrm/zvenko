import { type DynamicModule, Module } from "@nestjs/common";
import type { Logger } from "pino";
import { AuditModule } from "./audit/audit.module.js";
import type { Config } from "./config/config.js";
import { ConfigModule } from "./config/config.module.js";
import { CrmModule } from "./crm/crm.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { EventsModule } from "./events/events.module.js";
import { HealthModule } from "./health/health.module.js";
import { IdentityModule } from "./identity/identity.module.js";
import { TenancyModule } from "./tenancy/tenancy.module.js";

@Module({})
export class AppModule {
  static register(config: Config, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config, logger),
        DatabaseModule,
        IdentityModule,
        AuditModule,
        TenancyModule,
        EventsModule,
        HealthModule,
        CrmModule,
      ],
    };
  }
}
