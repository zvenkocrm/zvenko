import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAccess, type AccessContext, type Scope } from "../src/access.js";
import { newId } from "../src/ids.js";
import { deals, memberships, teams, tenants, users } from "../src/schema/index.js";
import { expectPgError, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

// Коды ошибок PostgreSQL.
const RLS_VIOLATION = "42501"; // new row violates row-level security policy
const FOREIGN_KEY_VIOLATION = "23503";

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

/** Менеджер userA1 из отдела A1 компании A. */
function contextA1(read: Scope = "all", write: Scope = "all"): AccessContext {
  return {
    tenantId: ids.tenantA,
    userId: ids.userA1,
    teamIds: [ids.teamA1],
    scopes: { deals: { read, write } },
  };
}

const sorted = (values: string[]) => [...values].sort();

async function visibleDeals(context: AccessContext): Promise<string[]> {
  const rows = await withAccess(db().app, context, (tx) => tx.select({ id: deals.id }).from(deals));
  return sorted(rows.map((row) => row.id));
}

/** Убирает из выражения политики все подзапросы «( SELECT …)» с учётом вложенных скобок. */
function withoutSubqueries(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    if (expr.startsWith("( SELECT", i)) {
      let depth = 0;
      do {
        if (expr[i] === "(") depth++;
        else if (expr[i] === ")") depth--;
        i++;
      } while (depth > 0 && i < expr.length);
    } else {
      out += expr.charAt(i);
      i++;
    }
  }
  return out;
}

describe("изоляция компаний (SEC-06)", () => {
  it("с областью «все» видны все сделки своей компании и ни одной чужой", async () => {
    expect(await visibleDeals(contextA1("all"))).toEqual(
      sorted([ids.dealA1, ids.dealA2, ids.dealA3]),
    );
  });

  it("видна только своя компания", async () => {
    const rows = await withAccess(db().app, contextA1(), (tx) =>
      tx.select({ id: tenants.id }).from(tenants),
    );
    expect(rows.map((row) => row.id)).toEqual([ids.tenantA]);
  });

  it("видны только сотрудники своей компании", async () => {
    const rows = await withAccess(db().app, contextA1(), (tx) =>
      tx.select({ id: users.id }).from(users),
    );
    expect(sorted(rows.map((row) => row.id))).toEqual(sorted([ids.userA1, ids.userA2, ids.userA3]));
  });

  it("видны только отделы и членства своей компании", async () => {
    const [teamRows, membershipRows] = await withAccess(db().app, contextA1(), async (tx) => [
      await tx.select({ id: teams.id }).from(teams),
      await tx.select({ tenantId: memberships.tenantId }).from(memberships),
    ]);
    expect(sorted(teamRows.map((row) => row.id))).toEqual(sorted([ids.teamA1, ids.teamA2]));
    expect(membershipRows.every((row) => row.tenantId === ids.tenantA)).toBe(true);
  });

  it("нельзя создать сделку в чужой компании", async () => {
    await expectPgError(
      withAccess(db().app, contextA1(), (tx) =>
        tx.insert(deals).values({
          tenantId: ids.tenantB,
          title: "чужая",
          ownerId: ids.userB1,
          teamId: ids.teamB1,
        }),
      ),
      RLS_VIOLATION,
    );
  });

  it("нельзя изменить или удалить сделку чужой компании — запрос её просто не видит", async () => {
    const [updated, deleted] = await withAccess(db().app, contextA1(), async (tx) => [
      await tx
        .update(deals)
        .set({ title: "взлом" })
        .where(eq(deals.id, ids.dealB1))
        .returning({ id: deals.id }),
      await tx.delete(deals).where(eq(deals.id, ids.dealB1)).returning({ id: deals.id }),
    ]);
    expect(updated).toHaveLength(0);
    expect(deleted).toHaveLength(0);
  });

  it("нельзя сослаться на отдел чужой компании — составной внешний ключ", async () => {
    await expectPgError(
      withAccess(db().app, contextA1(), (tx) =>
        tx.insert(deals).values({
          tenantId: ids.tenantA,
          title: "с чужим отделом",
          ownerId: ids.userA1,
          teamId: ids.teamB1,
        }),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });

  it("нельзя назначить ответственным сотрудника чужой компании", async () => {
    await expectPgError(
      withAccess(db().app, contextA1(), (tx) =>
        tx.insert(deals).values({ tenantId: ids.tenantA, title: "чужой", ownerId: ids.userB1 }),
      ),
      FOREIGN_KEY_VIOLATION,
    );
  });
});

describe("отказ по умолчанию", () => {
  it("без контекста доступа не видно ни одной строки ни в одной таблице", async () => {
    for (const table of [tenants, users, teams, memberships, deals]) {
      const rows = await db().app.select().from(table);
      expect(rows).toHaveLength(0);
    }
  });

  it("контекст не «перетекает» в следующий запрос на том же соединении", async () => {
    expect(await visibleDeals(contextA1())).toHaveLength(3);
    // Пул из одного соединения: следующий запрос идёт по тому же соединению, уже без контекста.
    expect(await db().app.select({ id: deals.id }).from(deals)).toHaveLength(0);
  });

  it("контекст с некорректными данными отклоняется до обращения к базе", async () => {
    const broken = { ...contextA1(), tenantId: "' or 1=1 --" };
    await expect(withAccess(db().app, broken, () => Promise.resolve(1))).rejects.toThrow(TypeError);
  });
});

describe("области видимости внутри компании (F-ROLE)", () => {
  it("«отдела» — сделки своего отдела, без сделок другого отдела", async () => {
    expect(await visibleDeals(contextA1("team"))).toEqual(sorted([ids.dealA1, ids.dealA2]));
  });

  it("«свои» — только свои сделки", async () => {
    expect(await visibleDeals(contextA1("own"))).toEqual([ids.dealA1]);
  });

  it("с областью записи «свои» можно менять свою сделку и нельзя — коллеги", async () => {
    const [own, colleague] = await withAccess(db().app, contextA1("all", "own"), async (tx) => [
      await tx
        .update(deals)
        .set({ title: "моя" })
        .where(eq(deals.id, ids.dealA1))
        .returning({ id: deals.id }),
      await tx
        .update(deals)
        .set({ title: "не моя" })
        .where(eq(deals.id, ids.dealA2))
        .returning({ id: deals.id }),
    ]);
    expect(own).toHaveLength(1);
    expect(colleague).toHaveLength(0);
  });

  it("с областью записи «свои» нельзя создать сделку на коллегу", async () => {
    await expectPgError(
      withAccess(db().app, contextA1("all", "own"), (tx) =>
        tx.insert(deals).values({
          tenantId: ids.tenantA,
          id: newId(),
          title: "на коллегу",
          ownerId: ids.userA2,
          teamId: ids.teamA1,
        }),
      ),
      RLS_VIOLATION,
    );
  });
});

describe("каталог БД — защищает и будущие таблицы (ADR-0002)", () => {
  it("на каждой таблице RLS включён и принудителен", async () => {
    const result = await db().adminPool.query<{ table: string; rls: boolean; forced: boolean }>(`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'`);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row, `RLS для ${row.table}`).toMatchObject({ rls: true, forced: true });
    }
  });

  it("у каждой таблицы с tenant_id есть ограничивающая политика изоляции", async () => {
    const result = await db().adminPool.query<{ table: string; isolated: boolean }>(`
      select c.relname as table,
             exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = c.relname
                       and p.policyname = 'tenant_isolation' and p.permissive = 'RESTRICTIVE') as isolated
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname = 'tenants' or exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped))`);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.isolated, `политика tenant_isolation для ${row.table}`).toBe(true);
    }
  });

  it("роль приложения — без суперпользователя и обхода RLS, ничем не владеет", async () => {
    const role = await db().adminPool.query<{ super: boolean; bypass: boolean; owned: string }>(`
      select r.rolsuper as super, r.rolbypassrls as bypass,
             (select count(*) from pg_tables t where t.tableowner = r.rolname) as owned
      from pg_roles r where r.rolname = 'zvenko_app'`);
    expect(role.rows).toEqual([{ super: false, bypass: false, owned: "0" }]);
  });

  it("роль приложения не может создавать и менять пользователей и компании", async () => {
    const grants = await db().adminPool.query<{ table: string; privilege: string }>(`
      select table_name as table, privilege_type as privilege
      from information_schema.role_table_grants
      where grantee = 'zvenko_app' and table_name in ('users', 'tenants')
        and privilege_type in ('INSERT', 'DELETE', 'TRUNCATE')`);
    expect(grants.rows).toEqual([]);
  });

  it("настройки контекста в политиках обёрнуты в подзапрос (вычисляются один раз)", async () => {
    const result = await db().adminPool.query<{ policy: string; expr: string }>(`
      select policyname as policy, coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
      from pg_policies where schemaname = 'public'`);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      // Голый current_setting(...) вне подзапроса вычислялся бы для каждой строки (PERF-06).
      expect(withoutSubqueries(row.expr), row.policy).not.toMatch(/current_setting\(/i);
    }
  });

  it("таблицами владеет роль без суперпользователя и обхода RLS — как в продакшене", async () => {
    const result = await db().adminPool.query<{ owner: string; super: boolean; bypass: boolean }>(`
      select distinct r.rolname as owner, r.rolsuper as super, r.rolbypassrls as bypass
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_roles r on r.oid = c.relowner
      where c.relkind = 'r' and n.nspname in ('public', 'identity', 'platform', 'audit')`);
    expect(result.rows).toEqual([{ owner: "zvenko_owner", super: false, bypass: false }]);
  });

  it("у функций SECURITY DEFINER закреплён search_path", async () => {
    // Функция с правами владельца не должна искать объекты в схемах вызывающего:
    // иначе подложенная им функция или таблица выполнится с правами владельца.
    const result = await db().adminPool.query<{ fn: string; config: string[] | null }>(`
      select p.oid::regprocedure::text as fn, p.proconfig as config
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')`);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.config ?? [], row.fn).toContain("search_path=pg_catalog, pg_temp");
    }
  });

  it("служебный запрос: текущая роль соединения приложения — zvenko_app", async () => {
    const result = await db().app.execute(sql`select current_user as role`);
    expect(result.rows).toEqual([{ role: "zvenko_app" }]);
  });
});
