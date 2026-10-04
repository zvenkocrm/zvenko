import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { asc, type Database, eventReceipts, inArray, outbox, sql } from "@zvenko/db";
import { fromDrizzle, type Job, PgBoss } from "pg-boss";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import { CONFIG, LOGGER } from "../config/config.module.js";
import { TenantDb } from "../tenancy/tenant-db.js";
import {
  type DeliveredEvent,
  deliveredEventSchema,
  type EventActor,
  type EventJson,
} from "./events.js";
import { DEFAULT_RETRY, type EventSubscriber, EventSubscribers } from "./subscribers.js";

export const WORKER_POOL = Symbol("WORKER_POOL");
export const WORKER_DB = Symbol("WORKER_DB");

/** Сколько событий диспетчер переносит за одну транзакцию. */
const DISPATCH_BATCH = 100;
/** Как часто диспетчер проверяет outbox, мс. */
const DISPATCH_INTERVAL_MS = 500;
/** Самая долгая пауза между повторами обработки, с. */
const RETRY_DELAY_MAX_SECONDS = 600;

/** Мёртвая очередь подписчика: события, не обработанные после всех повторов (F-EVT-03). */
export const deadLetterQueue = (subscriber: string): string => `${subscriber}.dead`;

function actorOf(type: string, id: string | null): EventActor {
  if ((type === "user" || type === "support") && id !== null) return { type, id };
  return { type: "system" };
}

/**
 * Фоновые задачи событий (ADR-0005), роль zvenko_worker:
 * - диспетчер переносит события из outbox в очереди подписчиков pg-boss и удаляет их
 *   из outbox — одной транзакцией: событие не теряется и не переносится дважды;
 * - обработчики подписчиков получают события из своих очередей; сбой — повтор с нарастающей
 *   паузой, после всех повторов — мёртвая очередь.
 *
 * Схему очереди ставит миграция: во время работы pg-boss схему не меняет.
 */
@Injectable()
export class EventWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private boss: PgBoss | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dispatching: Promise<void> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(WORKER_DB) private readonly workerDb: Database,
    private readonly tenantDb: TenantDb,
    private readonly subscribers: EventSubscribers,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.EVENTS_WORKER === "off") return;
    const boss = new PgBoss({
      connectionString: this.config.WORKER_DATABASE_URL,
      application_name: "zvenko-worker",
      schema: "pgboss",
      max: 4,
      // Схема — работа миграций владельца схемы: у роли фоновых задач нет прав её менять.
      migrate: false,
      createSchema: false,
      reindex: false,
    });
    boss.on("error", (err) => {
      this.logger.error({ err }, "ошибка очереди задач");
    });
    await boss.start();
    for (const subscriber of this.subscribers.all()) await this.connect(boss, subscriber);
    this.boss = boss;
    this.timer = setInterval(() => {
      this.kick();
    }, DISPATCH_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.dispatching;
    // Дожидаемся обработчиков, которые уже начали работу: пулы соединений закроются после.
    await this.boss?.stop({ graceful: true, timeout: 10_000 });
    this.boss = null;
  }

  /** Перенести всё из outbox сейчас, не дожидаясь таймера, — для тестов. */
  async dispatchNow(): Promise<void> {
    await this.dispatching;
    await this.drainOutbox();
  }

  /**
   * Пачка событий из outbox — в очереди подписчиков, одной транзакцией. Диспетчеры разных
   * процессов работают по очереди (рекомендательная блокировка): так роли фоновых задач
   * достаточно прав читать и удалять события, менять их ей не нужно.
   */
  private async dispatch(): Promise<number> {
    const boss = this.boss;
    if (!boss) return 0;
    return this.workerDb.transaction(async (tx) => {
      const lock = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('zvenko.outbox.dispatch')) as locked`,
      );
      if (lock.rows[0]?.locked !== true) return 0;

      const rows = await tx.select().from(outbox).orderBy(asc(outbox.id)).limit(DISPATCH_BATCH);
      for (const row of rows) {
        const event: DeliveredEvent = {
          id: row.id,
          tenantId: row.tenantId,
          type: row.type,
          object: { type: row.objectType, id: row.objectId },
          actor: actorOf(row.actorType, row.actorId),
          data: row.data as Readonly<Record<string, EventJson>>,
          occurredAt: row.occurredAt.toISOString(),
        };
        await boss.publish(row.type, event, { db: fromDrizzle(tx, sql) });
      }
      if (rows.length > 0) {
        await tx.delete(outbox).where(
          inArray(
            outbox.id,
            rows.map((row) => row.id),
          ),
        );
      }
      return rows.length;
    });
  }

  private async drainOutbox(): Promise<void> {
    let moved: number;
    do {
      moved = await this.dispatch();
    } while (moved === DISPATCH_BATCH);
  }

  /** Проход диспетчера по таймеру. Проходы не накладываются друг на друга. */
  private kick(): void {
    if (this.dispatching) return;
    this.dispatching = this.drainOutbox()
      .catch((err: unknown) => {
        this.logger.error({ err }, "события не перенесены в очередь — повтор на следующем проходе");
      })
      .finally(() => {
        this.dispatching = null;
      });
  }

  private async connect(boss: PgBoss, subscriber: EventSubscriber): Promise<void> {
    const retry = subscriber.retry ?? DEFAULT_RETRY;
    const dead = deadLetterQueue(subscriber.name);
    await boss.createQueue(dead);
    const options = {
      retryLimit: retry.limit,
      retryDelay: retry.delaySeconds,
      retryBackoff: true,
      retryDelayMax: RETRY_DELAY_MAX_SECONDS,
      deadLetter: dead,
    };
    await boss.createQueue(subscriber.name, options);
    // Очередь уже могла быть — настройки повторов приводим к тем, что в коде.
    await boss.updateQueue(subscriber.name, options);
    for (const type of subscriber.events) await boss.subscribe(type, subscriber.name);
    await boss.work<unknown>(
      subscriber.name,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (job) await this.deliver(subscriber, job);
      },
    );
  }

  /**
   * Обработка события — в транзакции компании события, вместе с отметкой «обработано».
   * Повторная доставка видит отметку и ничего не делает (REL-05).
   */
  private async deliver(subscriber: EventSubscriber, job: Job<unknown>): Promise<void> {
    const event = deliveredEventSchema.parse(job.data) as DeliveredEvent;
    await this.tenantDb.asSystem(event.tenantId, async (tx) => {
      const receipt = await tx
        .insert(eventReceipts)
        .values({ tenantId: event.tenantId, subscriber: subscriber.name, eventId: event.id })
        .onConflictDoNothing()
        .returning({ eventId: eventReceipts.eventId });
      if (receipt.length === 0) return;
      await subscriber.handle(tx, event);
    });
  }
}
