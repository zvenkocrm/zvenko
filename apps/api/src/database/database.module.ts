import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, type Database } from "@zvenko/db";
import pg from "pg";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { CONFIG, LOGGER } from "../config/config.module.js";

export const PG_POOL = Symbol("PG_POOL");
export const DATABASE = Symbol("DATABASE");

/**
 * Пул соединений ролью приложения. Без контекста доступа (withAccess) политики RLS
 * не показывают данных ни одной компании — забытая проверка прав не приводит к утечке.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, logger: Logger): pg.Pool => {
        const pool = new pg.Pool({
          connectionString: config.DATABASE_URL,
          max: config.DATABASE_POOL_MAX,
          application_name: "zvenko-api",
          connectionTimeoutMillis: 5_000,
          idleTimeoutMillis: 30_000,
          // Долгий запрос в API — ошибка: бюджет p95 — 200–300 мс (PERF-01).
          statement_timeout: 10_000,
          idle_in_transaction_session_timeout: 10_000,
        });
        // Без обработчика обрыв простаивающего соединения уронил бы процесс.
        pool.on("error", (err) => {
          logger.error({ err }, "ошибка соединения с PostgreSQL в пуле");
        });
        return pool;
      },
    },
    {
      provide: DATABASE,
      inject: [PG_POOL],
      useFactory: (pool: pg.Pool): Database => createDatabase(pool),
    },
  ],
  exports: [PG_POOL, DATABASE],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
