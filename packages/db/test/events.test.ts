import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AccessContext, withAccess } from "../src/access.js";
import { newId } from "../src/ids.js";
import { auditLog, deals, eventReceipts, memberships, outbox, users } from "../src/schema/index.js";
import { expectPgError, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

// Коды ошибок PostgreSQL.
const PERMISSION_DENIED = "42501"; // нет прав или запись не прошла политику RLS
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";

let started: TestDatabase | undefined;

function db(): TestDatabase {
  if (!started) throw new Error("тестовая БД не запущена");
  return started;
}

beforeAll(async () => {
  started = await startTestDatabase();
  await seed(started.admin);
});

afterAll(async () => {
  await started?.stop();
});

const context = (tenantId: string, userId: string): AccessContext => ({
  tenantId,
  userId,
  teamIds: [],
  scopes: { deals: { read: "own", write: "own" } },
});

const inA = context(ids.tenantA, ids.userA1);
const inB = context(ids.tenantB, ids.userB1);

const event = (tenantId: string, overrides: Partial<typeof outbox.$inferInsert> = {}) => ({
  tenantId,
  id: newId(),
  type: "deal.stage_changed",
  objectType: "deal",
  objectId: ids.dealA1,
  actorType: "user",
  actorId: ids.userA1,
  data: { stage: "won" },
  ...overrides,
});

describe("outbox: роль приложения только дописывает события своей компании (ADR-0005)", () => {
  it("событие своей компании — записывается", async () => {
    const written = event(ids.tenantA);
    await withAccess(db().app, inA, (tx) => tx.insert(outbox).values(written));
    const rows = await db().admin.select().from(outbox).where(eq(outbox.id, written.id));
    expect(rows).toMatchObject([{ tenantId: ids.tenantA, type: "deal.stage_changed" }]);
  });

  it("событие чужой компании — отклоняется", async () => {
    await expectPgError(
      withAccess(db().app, inA, (tx) => tx.insert(outbox).values(event(ids.tenantB))),
      PERMISSION_DENIED,
    );
  });

  it.each([
    ["прочитать", sql`select 1 from outbox`],
    ["изменить", sql`update outbox set type = 'deal.forged'`],
    ["удалить", sql`delete from outbox`],
  ])("%s события — нельзя, даже своей компании", async (_action, statement) => {
    await expectPgError(
      withAccess(db().app, inA, (tx) => tx.execute(statement)),
      PERMISSION_DENIED,
    );
  });

  it.each([
    ["тип без раздела", { type: "dealcreated" }],
    ["тип с заглавными буквами", { type: "Deal.Created" }],
    ["система с ID", { actorType: "system", actorId: ids.userA1 }],
    ["пользователь без ID", { actorType: "user", actorId: null }],
    ["подробности не объект", { data: ["x"] as unknown as Record<string, unknown> }],
    ["подробности больше 16 КБ", { data: { text: "x".repeat(17_000) } }],
  ])("запись отклоняется: %s", async (_case, overrides) => {
    await expectPgError(
      withAccess(db().app, inA, (tx) => tx.insert(outbox).values(event(ids.tenantA, overrides))),
      CHECK_VIOLATION,
    );
  });
});

describe("outbox: диспетчер — роль фоновых задач", () => {
  it("видит события всех компаний и удаляет перенесённые", async () => {
    const [first, second] = [event(ids.tenantA), event(ids.tenantB)];
    await db().admin.insert(outbox).values([first, second]);
    const seen = await db().worker.select({ id: outbox.id }).from(outbox);
    expect(seen.map((row) => row.id)).toEqual(expect.arrayContaining([first.id, second.id]));

    await db().worker.delete(outbox).where(eq(outbox.id, first.id));
    const left = await db()
      .admin.select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.id, first.id));
    expect(left).toEqual([]);
  });

  it("сам события не пишет и не меняет", async () => {
    await expectPgError(db().worker.insert(outbox).values(event(ids.tenantA)), PERMISSION_DENIED);
    await expectPgError(
      db().worker.execute(sql`update outbox set type = 'deal.forged'`),
      PERMISSION_DENIED,
    );
  });

  it.each([
    ["сделки", deals],
    ["сотрудники", memberships],
    ["пользователи", users],
    ["журнал аудита", auditLog],
    ["отметки обработчиков", eventReceipts],
  ] as const)("данные компаний не видит: %s", async (_name, table) => {
    await expectPgError(db().worker.select().from(table), PERMISSION_DENIED);
  });
});

describe("отметки обработанных событий (REL-05)", () => {
  it("повторная отметка того же события тем же подписчиком — отклоняется", async () => {
    const receipt = { tenantId: ids.tenantA, subscriber: "robots", eventId: newId() };
    await withAccess(db().app, inA, (tx) => tx.insert(eventReceipts).values(receipt));
    await expectPgError(
      withAccess(db().app, inA, (tx) => tx.insert(eventReceipts).values(receipt)),
      UNIQUE_VIOLATION,
    );
  });

  it("у другого подписчика — своя отметка", async () => {
    const eventId = newId();
    await withAccess(db().app, inA, (tx) =>
      tx.insert(eventReceipts).values([
        { tenantId: ids.tenantA, subscriber: "robots", eventId },
        { tenantId: ids.tenantA, subscriber: "notifications", eventId },
      ]),
    );
  });

  it("отметки чужой компании не видны и не пишутся", async () => {
    const eventId = newId();
    await withAccess(db().app, inA, (tx) =>
      tx.insert(eventReceipts).values({ tenantId: ids.tenantA, subscriber: "robots", eventId }),
    );
    const visible = await withAccess(db().app, inB, (tx) =>
      tx.select().from(eventReceipts).where(eq(eventReceipts.eventId, eventId)),
    );
    expect(visible).toEqual([]);
    await expectPgError(
      withAccess(db().app, inB, (tx) =>
        tx.insert(eventReceipts).values({ tenantId: ids.tenantA, subscriber: "x", eventId }),
      ),
      PERMISSION_DENIED,
    );
  });
});

describe("очередь pg-boss (ADR-0005)", () => {
  it("схема поставлена миграцией: версия схемы — 43, как у pg-boss 12.35.0", async () => {
    const result = await db().worker.execute<{ version: number }>(
      sql`select version from pgboss.version`,
    );
    expect(result.rows).toEqual([{ version: 43 }]);
  });

  it("роль фоновых задач ведёт очередь: читает и пишет её таблицы", async () => {
    await db().worker.execute(
      sql`select pgboss.create_queue('test-queue', '{"policy": "standard", "partition": false}'::jsonb)`,
    );
    const queues = await db().worker.execute<{ name: string }>(
      sql`select name from pgboss.queue where name = 'test-queue'`,
    );
    expect(queues.rows).toEqual([{ name: "test-queue" }]);
  });

  it.each([
    ["роль приложения", () => db().app],
    ["роль входа", () => db().identity],
  ])("%s в очередь не допущена", async (_role, database) => {
    await expectPgError(database().execute(sql`select 1 from pgboss.queue`), PERMISSION_DENIED);
  });

  it("роль фоновых задач не меняет схему очереди", async () => {
    await expectPgError(
      db().worker.execute(sql`create table pgboss.intruder (id int)`),
      PERMISSION_DENIED,
    );
  });
});

describe("каталог БД — роль фоновых задач", () => {
  it("без суперпользователя и обхода RLS, ничем не владеет", async () => {
    const role = await db().adminPool.query<{ super: boolean; bypass: boolean; owned: string }>(`
      select r.rolsuper as super, r.rolbypassrls as bypass,
             (select count(*) from pg_tables t where t.tableowner = r.rolname) as owned
      from pg_roles r where r.rolname = 'zvenko_worker'`);
    expect(role.rows).toEqual([{ super: false, bypass: false, owned: "0" }]);
  });

  it("в схеме public видит только outbox", async () => {
    const result = await db().adminPool.query<{ table: string }>(`
      select c.relname as table
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and has_table_privilege('zvenko_worker', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
      order by 1`);
    expect(result.rows).toEqual([{ table: "outbox" }]);
  });
});
