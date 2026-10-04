import { Injectable, type OnModuleInit } from "@nestjs/common";
import { and, deals, eq, eventReceipts, newId, outbox, type Transaction } from "@zvenko/db";
import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deadLetterQueue, EventWorker } from "../src/events/event-worker.js";
import { type DeliveredEvent, type DomainEvent, EventBus } from "../src/events/events.js";
import { type EventSubscriber, EventSubscribers } from "../src/events/subscribers.js";
import { TenantDb } from "../src/tenancy/tenant-db.js";
import { createTestApp, type TestApp } from "./helpers.js";

/** Тестовый подписчик: запоминает события и сделки, которые видит в контексте события. */
@Injectable()
class Recorder implements EventSubscriber, OnModuleInit {
  readonly name = "test.recorder";
  readonly events = ["deal.stage_changed"];
  readonly retry = { limit: 1, delaySeconds: 1 };
  readonly received: DeliveredEvent[] = [];
  readonly visibleDeals = new Map<string, string[]>();
  /** Сколько раз подряд упасть перед успехом; `Infinity` — падать всегда. */
  failures = 0;

  constructor(private readonly registry: EventSubscribers) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async handle(tx: Transaction, event: DeliveredEvent): Promise<void> {
    if (this.failures > 0) {
      this.failures--;
      throw new Error("сбой обработчика");
    }
    const rows = await tx.select({ id: deals.id }).from(deals);
    this.visibleDeals.set(event.id, rows.map((row) => row.id).sort());
    this.received.push(event);
  }
}

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;

function db(): TestDatabase {
  if (!database) throw new Error("тестовая БД не запущена");
  return database;
}

function app(): TestApp {
  if (!testApp) throw new Error("приложение не запущено");
  return testApp;
}

beforeAll(async () => {
  database = await startTestDatabase();
  await seed(database.admin);
  testApp = await createTestApp({
    databaseUrl: database.appUrl,
    workerUrl: database.workerUrl,
    providers: [Recorder],
  });
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

const recorder = () => app().app.get(Recorder);
const contextA = {
  tenantId: ids.tenantA,
  userId: ids.userA1,
  teamIds: [ids.teamA1],
  scopes: { deals: { read: "own", write: "own" } },
} as const;

const stageChanged = (dealId: string): DomainEvent => ({
  type: "deal.stage_changed",
  object: { type: "deal", id: dealId },
  actor: { type: "user", id: ids.userA1 },
  data: { stage: "won" },
});

/** Публикует событие компании A в транзакции, как это делает код предметной области. */
const publish = (event: DomainEvent) =>
  app()
    .app.get(TenantDb)
    .transaction(contextA, (tx) => app().app.get(EventBus).publish(tx, ids.tenantA, event));

/** Ждёт условие, проверяя его каждые 100 мс. */
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("не дождались");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const delivered = (eventId: string) => recorder().received.filter((event) => event.id === eventId);

describe("доставка событий (ADR-0005, F-EVT-01)", () => {
  it("событие из зафиксированной транзакции доставлено подписчику — со всеми полями", async () => {
    const eventId = await publish(stageChanged(ids.dealA1));
    await app().app.get(EventWorker).dispatchNow();
    await until(() => delivered(eventId).length > 0);

    expect(delivered(eventId)).toMatchObject([
      {
        id: eventId,
        tenantId: ids.tenantA,
        type: "deal.stage_changed",
        object: { type: "deal", id: ids.dealA1 },
        actor: { type: "user", id: ids.userA1 },
        data: { stage: "won" },
      },
    ]);
    // Перенесённое событие удалено из outbox.
    expect(await db().admin.select().from(outbox).where(eq(outbox.id, eventId))).toEqual([]);
  });

  it("событие из откатившейся транзакции не доставляется", async () => {
    const lostDeal = newId();
    await expect(
      app()
        .app.get(TenantDb)
        .transaction(contextA, async (tx) => {
          await app().app.get(EventBus).publish(tx, ids.tenantA, stageChanged(lostDeal));
          throw new Error("откат");
        }),
    ).rejects.toThrow("откат");

    // Событие-метка после отката: когда оно дошло, откатившееся дошло бы раньше.
    const markerId = await publish(stageChanged(ids.dealA2));
    await app().app.get(EventWorker).dispatchNow();
    await until(() => delivered(markerId).length > 0);
    expect(recorder().received.some((event) => event.object.id === lostDeal)).toBe(false);
  });

  it("обработчик видит данные только компании события", async () => {
    const eventId = await publish(stageChanged(ids.dealA1));
    await app().app.get(EventWorker).dispatchNow();
    await until(() => delivered(eventId).length > 0);
    expect(recorder().visibleDeals.get(eventId)).toEqual(
      [ids.dealA1, ids.dealA2, ids.dealA3].sort(),
    );
  });
});

describe("диспетчер", () => {
  it("диспетчеры работают по очереди: пока другой переносит события, этот ждёт", async () => {
    // Другой процесс-диспетчер держит блокировку в открытой транзакции.
    const other = new pg.Client({ connectionString: db().workerUrl });
    await other.connect();
    try {
      await other.query("begin");
      await other.query("select pg_advisory_xact_lock(hashtext('zvenko.outbox.dispatch'))");
      const eventId = await publish(stageChanged(ids.dealA1));
      await app().app.get(EventWorker).dispatchNow();
      const waiting = await db().admin.select().from(outbox).where(eq(outbox.id, eventId));
      expect(waiting).toHaveLength(1);

      await other.query("rollback");
      await app().app.get(EventWorker).dispatchNow();
      await until(() => delivered(eventId).length > 0);
    } finally {
      await other.end();
    }
  });
});

describe("хотя бы один раз — и без повторных действий (F-EVT-02, REL-05)", () => {
  it("повторная доставка того же события не повторяет обработку", async () => {
    const event: DeliveredEvent = {
      ...stageChanged(ids.dealA3),
      id: newId(),
      tenantId: ids.tenantA,
      data: { stage: "won" },
      occurredAt: new Date().toISOString(),
    };
    // Отдельный клиент очереди — как второй процесс, доставивший событие повторно.
    const boss = new PgBoss({
      connectionString: db().workerUrl,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      const first = await boss.send(recorder().name, event);
      const second = await boss.send(recorder().name, event);
      await until(async () => {
        const jobs = await Promise.all(
          [first, second].map((id) => boss.findJobs(recorder().name, { id: id ?? "" })),
        );
        return jobs.every(([job]) => job?.state === "completed");
      });
    } finally {
      await boss.stop({ graceful: false });
    }

    expect(delivered(event.id)).toHaveLength(1);
    const receipts = await db()
      .admin.select()
      .from(eventReceipts)
      .where(
        and(eq(eventReceipts.eventId, event.id), eq(eventReceipts.subscriber, recorder().name)),
      );
    expect(receipts).toHaveLength(1);
  });

  it("сбой обработчика — повтор после паузы, затем успех", async () => {
    recorder().failures = 1;
    const eventId = await publish(stageChanged(ids.dealA2));
    await app().app.get(EventWorker).dispatchNow();
    await until(() => delivered(eventId).length > 0);
    expect(delivered(eventId)).toHaveLength(1);
    expect(recorder().failures).toBe(0);
  });

  it("сбой после всех повторов — событие в мёртвой очереди (F-EVT-03)", async () => {
    recorder().failures = Number.POSITIVE_INFINITY;
    const eventId = await publish(stageChanged(ids.dealA3));
    const boss = new PgBoss({
      connectionString: db().workerUrl,
      migrate: false,
      createSchema: false,
      supervise: false,
      schedule: false,
    });
    await boss.start();
    try {
      await app().app.get(EventWorker).dispatchNow();
      let dead: { data: unknown }[] = [];
      await until(async () => {
        dead = await boss.findJobs(deadLetterQueue(recorder().name), { data: { id: eventId } });
        return dead.length > 0;
      }, 25_000);
      expect(dead[0]?.data).toMatchObject({ id: eventId, tenantId: ids.tenantA });
      expect(delivered(eventId)).toEqual([]);
    } finally {
      recorder().failures = 0;
      await boss.stop({ graceful: false });
    }
  });
});
