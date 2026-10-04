import { asc, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AccessContext, withAccess } from "../src/access.js";
import { appendAuditEntry, type AuditEntry, verifyAuditLog } from "../src/audit.js";
import { createDatabase, type Database } from "../src/client.js";
import { newId } from "../src/ids.js";
import { auditChainHeads, auditLog, tenants } from "../src/schema/index.js";
import { expectPgError, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

// Коды ошибок PostgreSQL.
const PERMISSION_DENIED = "42501"; // нет прав или запись не прошла политику RLS
const CHECK_VIOLATION = "23514";
const LOCK_NOT_AVAILABLE = "55P03";

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

/** Контекст компании: для журнала RLS проверяет только компанию. */
const context = (tenantId: string): AccessContext => ({
  tenantId,
  userId: newId(),
  teamIds: [],
  scopes: { deals: { read: "own", write: "own" } },
});

/** Новая компания с пустым журналом — чтобы тесты не зависели друг от друга. */
let tenantCount = 0;
async function newTenant(): Promise<string> {
  const id = newId();
  tenantCount++;
  await db()
    .admin.insert(tenants)
    .values({ id, name: "Журнал", subdomain: `audit-${String(tenantCount)}` });
  return id;
}

const entry = (tenantId: string, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  tenantId,
  actor: { type: "user", id: ids.userA1 },
  action: "session.tenant_selected",
  result: "success",
  ip: "192.0.2.10",
  userAgent: "Mozilla/5.0",
  requestId: newId(),
  ...overrides,
});

/** Запись ролью приложения в транзакции с контекстом компании — как в API. */
const append = (tenantId: string, overrides?: Partial<AuditEntry>, database: Database = db().app) =>
  withAccess(database, context(tenantId), (tx) => appendAuditEntry(tx, entry(tenantId, overrides)));

async function journalWith(count: number): Promise<string> {
  const tenantId = await newTenant();
  for (let i = 0; i < count; i++) await append(tenantId);
  return tenantId;
}

const rowsOf = (tenantId: string) =>
  db()
    .admin.select()
    .from(auditLog)
    .where(eq(auditLog.tenantId, tenantId))
    .orderBy(asc(auditLog.seq));

class Rollback extends Error {}

describe("запись в журнал (F-AUD-02)", () => {
  it("номер, время и хэши ставит БД: записи идут по порядку и связаны в цепочку", async () => {
    const tenantId = await newTenant();
    const seqs: number[] = [];
    for (let i = 0; i < 3; i++) seqs.push((await append(tenantId)).seq);
    expect(seqs).toEqual([1, 2, 3]);

    const rows = await rowsOf(tenantId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0]?.prevHash).toEqual(Buffer.alloc(32));
    expect(rows[1]?.prevHash).toEqual(rows[0]?.hash);
    expect(rows[2]?.prevHash).toEqual(rows[1]?.hash);
    for (const row of rows) {
      expect(row.hash).toHaveLength(32);
      expect(row.hashVersion).toBe(1);
    }
    const times = rows.map((row) => row.occurredAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));

    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({ ok: true, entries: 3 });
  });

  it("хэш в БД и в проверке считается одинаково — на неудобных значениях", async () => {
    const tenantId = await newTenant();
    await append(tenantId, {
      actor: { type: "anonymous" },
      result: "failure",
      ip: "2001:db8::1",
      userAgent: "Mozilla/5.0 (Linux; Android 14) «ёлка» 🎄",
      details: {
        domain: "пример.рф",
        nested: { list: [1, 2.5, "три", null, true] },
        quote: `"\\'`,
      },
    });
    await append(tenantId, {
      actor: { type: "system" },
      object: { type: "tenant", id: tenantId },
      ip: "::ffff:192.0.2.1",
      userAgent: null,
      requestId: null,
      details: {},
    });
    await append(tenantId, {
      actor: { type: "support", id: ids.userB1 },
      ip: null,
      userAgent: "",
      details: { emoji: "👩‍💻", big: 9007199254740991, huge: 1e21, small: 0.1 },
    });
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({ ok: true, entries: 3 });
  });

  it("у каждой компании своя цепочка", async () => {
    const [first, second] = [await newTenant(), await newTenant()];
    expect((await append(first)).seq).toBe(1);
    expect((await append(second)).seq).toBe(1);
    expect((await append(first)).seq).toBe(2);
    expect(await verifyAuditLog(db().admin, first)).toEqual({ ok: true, entries: 2 });
    expect(await verifyAuditLog(db().admin, second)).toEqual({ ok: true, entries: 1 });
  });

  it("проверку можно запустить ролью приложения в контексте компании", async () => {
    const tenantId = await journalWith(2);
    const verification = await withAccess(db().app, context(tenantId), (tx) =>
      verifyAuditLog(tx, tenantId),
    );
    expect(verification).toEqual({ ok: true, entries: 2 });
  });

  it.each([
    ["seq", "100"],
    ["occurred_at", "2020-01-01T00:00:00Z"],
    ["hash_version", "1"],
    ["prev_hash", "\\x00"],
    ["hash", "\\x00"],
  ])("роль приложения не может задать %s сама — нет прав на колонку", async (column, value) => {
    const tenantId = await newTenant();
    await expectPgError(
      withAccess(db().app, context(tenantId), (tx) =>
        tx.execute(sql`insert into audit_log (tenant_id, actor_type, action, result, ${sql.identifier(column)})
          values (${tenantId}, 'system', 'session.tenant_selected', 'success', ${value})`),
      ),
      PERMISSION_DENIED,
    );
  });

  it("номер, время и хэши, присланные администратором БД, триггер перезаписывает", async () => {
    const tenantId = await newTenant();
    const { rows } = await db().adminPool.query<{ seq: string; year: number }>(
      `insert into audit_log (tenant_id, actor_type, action, result, seq, occurred_at,
                              hash_version, prev_hash, hash)
       values ($1, 'system', 'session.tenant_selected', 'success', 100, '2000-01-01', 9,
               '\\x00', '\\x00')
       returning seq, extract(year from occurred_at)::int as year`,
      [tenantId],
    );
    expect(rows[0]?.seq).toBe("1");
    expect(rows[0]?.year).toBeGreaterThan(2000);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({ ok: true, entries: 1 });
  });

  it.each<[string, Partial<AuditEntry>]>([
    ["действие не в формате «раздел.действие»", { action: "DROP TABLE" }],
    ["пользователь без ID", { actor: { type: "user" } as unknown as AuditEntry["actor"] }],
    ["система с ID", { actor: { type: "system", id: ids.userA1 } as AuditEntry["actor"] }],
    ["неизвестный результат", { result: "maybe" as AuditEntry["result"] }],
    ["тип объекта без ID", { object: { type: "deal" } as AuditEntry["object"] }],
    ["IP с маской сети", { ip: "10.0.0.0/8" }],
    ["слишком длинный User-Agent", { userAgent: "x".repeat(513) }],
    ["ID запроса со спецсимволами", { requestId: "id; drop table" }],
    ["подробности не объект", { details: ["x"] as unknown as AuditEntry["details"] }],
    ["подробности больше 4 КБ", { details: { text: "x".repeat(5000) } }],
  ])("запись отклоняется: %s", async (_case, overrides) => {
    const tenantId = await newTenant();
    await expectPgError(append(tenantId, overrides), CHECK_VIOLATION);
  });
});

describe("изоляция журналов компаний (SEC-06)", () => {
  it("запись в журнал чужой компании отклоняется", async () => {
    const [own, foreign] = [await newTenant(), await newTenant()];
    await expectPgError(
      withAccess(db().app, context(own), (tx) => appendAuditEntry(tx, entry(foreign))),
      PERMISSION_DENIED,
    );
    // Отклонённая запись не оставила следа в чужой цепочке.
    expect(await verifyAuditLog(db().admin, foreign)).toEqual({ ok: true, entries: 0 });
  });

  it("компания видит только свой журнал и голову своей цепочки", async () => {
    const [first, second] = [await journalWith(1), await journalWith(1)];
    const [entries, heads] = await withAccess(db().app, context(second), async (tx) => [
      await tx.select({ tenantId: auditLog.tenantId }).from(auditLog),
      await tx.select({ tenantId: auditChainHeads.tenantId }).from(auditChainHeads),
    ]);
    expect(entries.map((row) => row.tenantId)).toEqual([second]);
    expect(heads.map((row) => row.tenantId)).toEqual([second]);
    expect(entries.map((row) => row.tenantId)).not.toContain(first);
  });

  it("роль модуля входа журнал не видит", async () => {
    await expectPgError(db().identity.execute(sql`select 1 from audit_log`), PERMISSION_DENIED);
    await expectPgError(
      db().identity.execute(sql`select 1 from audit.chain_heads`),
      PERMISSION_DENIED,
    );
  });
});

describe("записи нельзя изменить или удалить (F-AUD-04)", () => {
  it.each([
    ["UPDATE", sql`update audit_log set action = 'session.forged'`],
    ["DELETE", sql`delete from audit_log`],
    ["TRUNCATE", sql`truncate audit_log`],
  ])("роль приложения: %s запрещён правами", async (_operation, statement) => {
    const tenantId = await journalWith(1);
    await expectPgError(
      withAccess(db().app, context(tenantId), async (tx) => {
        // Настройка очистки журнала роли приложения не помогает: прав на удаление у неё нет.
        await tx.execute(sql`select set_config('zvenko.audit_purge', 'on', true)`);
        return tx.execute(statement);
      }),
      PERMISSION_DENIED,
    );
  });

  it.each([
    ["UPDATE", "update audit_log set action = 'session.forged' where tenant_id = $1"],
    ["DELETE", "delete from audit_log where tenant_id = $1"],
  ])("администратор БД: %s запрещён триггером", async (operation, statement) => {
    const tenantId = await journalWith(1);
    await expect(db().adminPool.query(statement, [tenantId])).rejects.toThrow(
      `журнал аудита только дописывается: ${operation} запрещён`,
    );
  });

  it("владелец схемы не видит и не меняет записи: RLS действует и на него", async () => {
    const tenantId = await journalWith(1);
    const visible = await db().owner.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    expect(visible).toEqual([]);
    const updated = await db().owner.execute(
      sql`update audit_log set action = 'session.forged' where tenant_id = ${tenantId}`,
    );
    expect(updated.rowCount).toBe(0);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({ ok: true, entries: 1 });
  });

  it("администратор БД: TRUNCATE запрещён триггером", async () => {
    await journalWith(1);
    await expect(db().adminPool.query("truncate audit_log")).rejects.toThrow(
      "журнал аудита только дописывается: TRUNCATE запрещён",
    );
  });

  it("компания с журналом удаляется только с явной очисткой журнала; правка запрещена и тогда", async () => {
    const tenantId = await journalWith(2);
    const client = await db().adminPool.connect();
    try {
      await expect(client.query("delete from tenants where id = $1", [tenantId])).rejects.toThrow(
        "журнал аудита только дописывается: DELETE запрещён",
      );

      await client.query("begin");
      await client.query("select set_config('zvenko.audit_purge', 'on', true)");
      await expect(
        client.query("update audit_log set action = 'session.forged' where tenant_id = $1", [
          tenantId,
        ]),
      ).rejects.toThrow("журнал аудита только дописывается: UPDATE запрещён");
      await client.query("rollback");

      await client.query("begin");
      await client.query("select set_config('zvenko.audit_purge', 'on', true)");
      await client.query("delete from tenants where id = $1", [tenantId]);
      await client.query("commit");
    } finally {
      // Соединение с настройками и, при падении теста, с открытой транзакцией — не в пул.
      client.release(true);
    }
    expect(await rowsOf(tenantId)).toEqual([]);
    const heads = await db()
      .admin.select()
      .from(auditChainHeads)
      .where(eq(auditChainHeads.tenantId, tenantId));
    expect(heads).toEqual([]);
  });
});

/**
 * Подмена в обход триггера — так может действовать только администратор БД (суперпользователь)
 * или тот, кто получил его права: отключает защиту, меняет данные, включает защиту обратно.
 */
async function tamper(statement: string, params: unknown[]): Promise<void> {
  const client = await db().adminPool.connect();
  try {
    await client.query("begin");
    await client.query("alter table audit_log disable trigger audit_log_immutable");
    await client.query(statement, params);
    await client.query("alter table audit_log enable trigger audit_log_immutable");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Хэш записи формата 1 — как в триггере, но по колонкам строки. */
const ROW_HASH = `sha256(prev_hash
  || audit.hash_field(hash_version::text) || audit.hash_field(tenant_id::text)
  || audit.hash_field(seq::text)
  || audit.hash_field(to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  || audit.hash_field(actor_type) || audit.hash_field(actor_id::text) || audit.hash_field(action)
  || audit.hash_field(result) || audit.hash_field(object_type) || audit.hash_field(object_id::text)
  || audit.hash_field(host(ip)) || audit.hash_field(user_agent) || audit.hash_field(request_id)
  || audit.hash_field(details::text))`;

describe("проверка цепочки находит подмену (SEC-07)", () => {
  it.each([
    ["действие", "action = 'session.forged'"],
    ["результат", "result = 'failure'"],
    ["кто", "actor_id = gen_random_uuid()"],
    ["объект", "object_type = 'tenant', object_id = tenant_id"],
    ["IP", "ip = '203.0.113.1'"],
    ["устройство", "user_agent = 'curl/8.0'"],
    ["ID запроса", "request_id = 'forged-request-id'"],
    ["время", "occurred_at = occurred_at - interval '1 hour'"],
    ["подробности", `details = '{"forged": true}'`],
    ["версия формата", "hash_version = 2"],
  ])("изменено поле «%s» — запись 2 не совпадает с хэшем", async (_field, assignment) => {
    const tenantId = await journalWith(3);
    await tamper(`update audit_log set ${assignment} where tenant_id = $1 and seq = 2`, [tenantId]);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({
      ok: false,
      seq: 2,
      problem: "hash",
    });
  });

  it("запись изменена и её хэш пересчитан — разрыв ссылки у следующей записи", async () => {
    const tenantId = await journalWith(3);
    await tamper(
      "update audit_log set action = 'session.forged' where tenant_id = $1 and seq = 2",
      [tenantId],
    );
    await tamper(`update audit_log set hash = ${ROW_HASH} where tenant_id = $1 and seq = 2`, [
      tenantId,
    ]);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({
      ok: false,
      seq: 3,
      problem: "link",
    });
  });

  it("удалена запись из середины", async () => {
    const tenantId = await journalWith(3);
    await tamper("delete from audit_log where tenant_id = $1 and seq = 2", [tenantId]);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({
      ok: false,
      seq: 2,
      problem: "sequence",
    });
  });

  it("удалены последние записи — цепочка не доходит до головы", async () => {
    const tenantId = await journalWith(3);
    await tamper("delete from audit_log where tenant_id = $1 and seq = 3", [tenantId]);
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({
      ok: false,
      seq: 3,
      problem: "head",
    });
  });

  it("проверка идёт пачками и не теряет записи на их границе", async () => {
    const tenantId = await journalWith(5);
    expect(await verifyAuditLog(db().admin, tenantId, 2)).toEqual({ ok: true, entries: 5 });
    await tamper("delete from audit_log where tenant_id = $1 and seq = 3", [tenantId]);
    expect(await verifyAuditLog(db().admin, tenantId, 2)).toEqual({
      ok: false,
      seq: 3,
      problem: "sequence",
    });
  });
});

describe("очередь записей одной компании", () => {
  it("параллельные записи — номера без пропусков и повторов, цепочка цела", async () => {
    const tenantId = await newTenant();
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 6 });
    try {
      const parallel = createDatabase(pool);
      const seqs = await Promise.all(
        Array.from({ length: 12 }, () =>
          withAccess(parallel, context(tenantId), async (tx) => {
            const appended = await appendAuditEntry(tx, entry(tenantId));
            // Транзакция держит голову цепочки — остальные ждут своей очереди.
            await tx.execute(sql`select pg_sleep(0.02)`);
            return appended.seq;
          }),
        ),
      );
      expect([...seqs].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    } finally {
      await pool.end();
    }
    expect(await verifyAuditLog(db().admin, tenantId)).toEqual({ ok: true, entries: 12 });
  });

  it("запись компании ждёт незавершённую запись той же компании, другая компания — нет; откат не оставляет дыр", async () => {
    const [first, second] = [await newTenant(), await newTenant()];
    const pool = new pg.Pool({ connectionString: db().appUrl, max: 3 });
    try {
      const parallel = createDatabase(pool);
      let release = (): void => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let appended = (): void => undefined;
      const holding = new Promise<void>((resolve) => {
        appended = resolve;
      });
      // Транзакция дописывает запись первой компании и висит, пока её не отпустят.
      const holder = withAccess(parallel, context(first), async (tx) => {
        await appendAuditEntry(tx, entry(first));
        appended();
        await released;
        throw new Rollback();
      }).catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });

      try {
        await holding;
        await expectPgError(
          withAccess(parallel, context(first), async (tx) => {
            await tx.execute(sql`set local lock_timeout = '300ms'`);
            return appendAuditEntry(tx, entry(first));
          }),
          LOCK_NOT_AVAILABLE,
        );
        expect((await append(second, {}, parallel)).seq).toBe(1);
      } finally {
        release();
        await holder;
      }

      // Запись в откаченной транзакции не заняла номер.
      expect((await append(first, {}, parallel)).seq).toBe(1);
    } finally {
      await pool.end();
    }
    expect(await verifyAuditLog(db().admin, first)).toEqual({ ok: true, entries: 1 });
  });
});

describe("каталог БД — журнал аудита", () => {
  const CONTENT = [
    "tenant_id",
    "actor_type",
    "actor_id",
    "action",
    "result",
    "object_type",
    "object_id",
    "ip",
    "user_agent",
    "request_id",
    "details",
  ];
  const SET_BY_TRIGGER = ["seq", "occurred_at", "hash_version", "prev_hash", "hash"];

  it("роль приложения: чтение и вставка содержимого; UPDATE, DELETE, TRUNCATE не выданы", async () => {
    const { rows } = await db().adminPool.query<{ privilege: string; granted: boolean }>(`
      select privilege, has_table_privilege('zvenko_app', 'audit_log', privilege) as granted
      from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])
        as privilege`);
    // INSERT на всю таблицу не выдан — только на колонки содержимого.
    expect(Object.fromEntries(rows.map((row) => [row.privilege, row.granted]))).toEqual({
      SELECT: true,
      INSERT: false,
      UPDATE: false,
      DELETE: false,
      TRUNCATE: false,
      REFERENCES: false,
      TRIGGER: false,
    });
  });

  it("вставка разрешена в колонки содержимого и запрещена в колонки триггера", async () => {
    const { rows } = await db().adminPool.query<{ column: string; granted: boolean }>(
      `select attname as column, has_column_privilege('zvenko_app', 'audit_log', attname, 'INSERT') as granted
       from pg_attribute where attrelid = 'audit_log'::regclass and attnum > 0 and not attisdropped`,
    );
    const granted = Object.fromEntries(rows.map((row) => [row.column, row.granted]));
    expect(granted).toEqual(
      Object.fromEntries([
        ...CONTENT.map((column) => [column, true]),
        ...SET_BY_TRIGGER.map((column) => [column, false]),
      ]),
    );
  });

  it("голова цепочки: RLS с изоляцией компаний, приложению — только чтение", async () => {
    const { rows } = await db().adminPool.query<{
      rls: boolean;
      isolated: boolean;
      select: boolean;
      write: boolean;
    }>(`
      select c.relrowsecurity as rls,
             exists (select 1 from pg_policies p
                     where p.schemaname = 'audit' and p.tablename = 'chain_heads'
                       and p.policyname = 'tenant_isolation' and p.permissive = 'RESTRICTIVE') as isolated,
             has_table_privilege('zvenko_app', c.oid, 'SELECT') as select,
             has_table_privilege('zvenko_app', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') as write
      from pg_class c where c.oid = 'audit.chain_heads'::regclass`);
    expect(rows).toEqual([{ rls: true, isolated: true, select: true, write: false }]);
  });
});
