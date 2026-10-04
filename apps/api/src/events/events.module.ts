import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { createDatabase, type Database } from "@zvenko/db";
import type pg from "pg";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { CONFIG, LOGGER } from "../config/config.module.js";
import { createPgPool } from "../database/database.module.js";
import { EventWorker, WORKER_DB, WORKER_POOL } from "./event-worker.js";
import { EventBus } from "./events.js";
import { EventSubscribers } from "./subscribers.js";

/**
 * События (ADR-0005, F-EVT): публикация в транзакции изменения, перенос в очередь
 * и обработка подписчиками. Фоновые задачи работают своей ролью zvenko_worker.
 */
@Global()
@Module({
  providers: [
    {
      provide: WORKER_POOL,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, logger: Logger): pg.Pool =>
        createPgPool(
          {
            connectionString: config.WORKER_DATABASE_URL,
            max: 2,
            applicationName: "zvenko-worker-dispatch",
          },
          logger,
        ),
    },
    {
      provide: WORKER_DB,
      inject: [WORKER_POOL],
      useFactory: (pool: pg.Pool): Database => createDatabase(pool),
    },
    EventBus,
    EventSubscribers,
    EventWorker,
  ],
  exports: [EventBus, EventSubscribers],
})
export class EventsModule implements OnApplicationShutdown {
  constructor(@Inject(WORKER_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
