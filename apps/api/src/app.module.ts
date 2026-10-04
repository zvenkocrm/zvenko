import { type DynamicModule, Module } from "@nestjs/common";
import type { Logger } from "pino";
import type { Config } from "./config/config.js";
import { ConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";

@Module({})
export class AppModule {
  static register(config: Config, logger: Logger): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.register(config, logger), DatabaseModule, HealthModule],
    };
  }
}
