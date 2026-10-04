import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, type Database } from "@zvenko/db";
import type pg from "pg";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { CONFIG, LOGGER } from "../config/config.module.js";
import { createPgPool } from "../database/database.module.js";
import { createAuth } from "./auth.js";
import { AuthController } from "./auth.controller.js";
import { AuthPort } from "./auth.port.js";
import { BetterAuthAdapter } from "./better-auth.adapter.js";
import { IdentityService } from "./identity.service.js";
import { AUTH, IDENTITY_DB, IDENTITY_POOL } from "./tokens.js";

/**
 * Модуль входа (ADR-0006): свой пул соединений ролью zvenko_identity — пароли и сессии
 * не смешиваются с данными компаний ни в коде, ни в правах БД.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: IDENTITY_POOL,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, logger: Logger): pg.Pool =>
        createPgPool(
          {
            connectionString: config.IDENTITY_DATABASE_URL,
            max: 5,
            applicationName: "zvenko-identity",
          },
          logger,
        ),
    },
    {
      provide: IDENTITY_DB,
      inject: [IDENTITY_POOL],
      useFactory: (pool: pg.Pool): Database => createDatabase(pool),
    },
    {
      provide: AUTH,
      inject: [IDENTITY_DB, CONFIG, LOGGER],
      useFactory: createAuth,
    },
    { provide: AuthPort, useClass: BetterAuthAdapter },
    IdentityService,
  ],
  exports: [AuthPort, IdentityService],
})
export class IdentityModule implements OnApplicationShutdown {
  constructor(@Inject(IDENTITY_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
