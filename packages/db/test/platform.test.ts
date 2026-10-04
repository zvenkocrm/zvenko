import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAccess, withUser } from "../src/access.js";
import { newId } from "../src/ids.js";
import {
  memberships,
  membershipDirectory,
  tenantDirectory,
  tenants,
  users,
} from "../src/schema/index.js";
import { pgErrorCode, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

const PERMISSION_DENIED = "42501";

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

async function errorCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return pgErrorCode(error);
  }
  return undefined;
}

const adminOfA = {
  tenantId: ids.tenantA,
  userId: ids.userA1,
  teamIds: [ids.teamA1],
  scopes: { deals: { read: "all", write: "all" } },
} as const;

describe("справочник «поддомен → компания» (ADR-0002)", () => {
  it("заполняется сам: и для уже созданных компаний, и для новых", async () => {
    const tenantId = newId();
    await db().admin.insert(tenants).values({ id: tenantId, name: "Новая", subdomain: "novaya" });
    const rows = await db()
      .admin.select({ subdomain: tenantDirectory.subdomain })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(rows).toEqual([{ subdomain: "novaya" }]);

    const seeded = await db().admin.select().from(tenantDirectory);
    expect(seeded.map((row) => row.subdomain)).toEqual(
      expect.arrayContaining(["company-a", "company-b", "novaya"]),
    );
  });

  it("следует за сменой поддомена и исчезает вместе с компанией", async () => {
    const tenantId = newId();
    await db()
      .admin.insert(tenants)
      .values({ id: tenantId, name: "Временная", subdomain: "vremya" });
    await db().admin.update(tenants).set({ subdomain: "vremya-2" }).where(eq(tenants.id, tenantId));
    const [moved] = await db()
      .admin.select({ subdomain: tenantDirectory.subdomain })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(moved?.subdomain).toBe("vremya-2");

    await db().admin.delete(tenants).where(eq(tenants.id, tenantId));
    const gone = await db()
      .admin.select()
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(gone).toEqual([]);
  });

  it("роль приложения читает справочник без контекста компании — по адресу сайта", async () => {
    const rows = await db()
      .app.select({ tenantId: tenantDirectory.tenantId })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.subdomain, "company-a"));
    expect(rows).toEqual([{ tenantId: ids.tenantA }]);
  });

  it("писать в справочник роль приложения не может", async () => {
    const code = await errorCode(() =>
      db()
        .app.update(tenantDirectory)
        .set({ tenantId: ids.tenantB })
        .where(eq(tenantDirectory.subdomain, "company-a")),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("роль входа схему платформы не видит", async () => {
    const code = await errorCode(() => db().identity.select().from(tenantDirectory));
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe("компания меняет только название (F-TEN-01, F-TEN-03)", () => {
  it("название — можно", async () => {
    await withAccess(db().app, adminOfA, (tx) =>
      tx.update(tenants).set({ name: "Компания A+" }).where(eq(tenants.id, ids.tenantA)),
    );
    const [row] = await db()
      .admin.select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ids.tenantA));
    expect(row?.name).toBe("Компания A+");
  });

  it.each([
    ["поддомен", { subdomain: "stolen" }],
    ["регион", { region: "eu-central1" }],
  ] as const)("%s — нельзя: это делает только платформа", async (_name, change) => {
    const code = await errorCode(() =>
      withAccess(db().app, adminOfA, (tx) =>
        tx.update(tenants).set(change).where(eq(tenants.id, ids.tenantA)),
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe("справочник «пользователь → компании» (D30, F-AUTH-06)", () => {
  /** Компании пользователя глазами роли приложения — в контексте этого пользователя. */
  const tenantsOf = (userId: string) =>
    withUser(db().app, userId, (tx) =>
      tx.select({ tenantId: membershipDirectory.tenantId }).from(membershipDirectory),
    ).then((rows) => rows.map((row) => row.tenantId).sort());

  async function newUser(): Promise<string> {
    const id = newId();
    await db()
      .admin.insert(users)
      .values({ id, email: `${id}@example.test`, name: "Партнёр" });
    return id;
  }

  it("повторяет членства: сотрудник двух компаний видит обе", async () => {
    const userId = await newUser();
    await db()
      .admin.insert(memberships)
      .values([
        { tenantId: ids.tenantA, userId, teamId: ids.teamA1, role: "manager" },
        { tenantId: ids.tenantB, userId, teamId: ids.teamB1, role: "manager" },
      ]);
    expect(await tenantsOf(userId)).toEqual([ids.tenantA, ids.tenantB].sort());
  });

  it("членство добавила роль приложения в своей компании — справочник тоже обновился", async () => {
    const userId = await newUser();
    await withAccess(db().app, adminOfA, (tx) =>
      tx
        .insert(memberships)
        .values({ tenantId: ids.tenantA, userId, teamId: ids.teamA1, role: "manager" }),
    );
    expect(await tenantsOf(userId)).toEqual([ids.tenantA]);
  });

  it("отключение сотрудника и перевод в другую компанию — справочник следует за членством", async () => {
    const userId = await newUser();
    await db()
      .admin.insert(memberships)
      .values({ tenantId: ids.tenantA, userId, teamId: null, role: "manager" });
    await db()
      .admin.update(memberships)
      .set({ tenantId: ids.tenantB })
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, ids.tenantA)));
    expect(await tenantsOf(userId)).toEqual([ids.tenantB]);

    await db().admin.delete(memberships).where(eq(memberships.userId, userId));
    expect(await tenantsOf(userId)).toEqual([]);
  });

  it("роль приложения видит только компании пользователя из контекста", async () => {
    expect(await tenantsOf(ids.userA1)).toEqual([ids.tenantA]);
    expect(await tenantsOf(ids.userB1)).toEqual([ids.tenantB]);
    // Без контекста — ничего: справочник целиком не читается.
    expect(await db().app.select().from(membershipDirectory)).toEqual([]);
  });

  it("писать в справочник роль приложения не может", async () => {
    const code = await errorCode(() =>
      withUser(db().app, ids.userA1, (tx) =>
        tx.insert(membershipDirectory).values({ userId: ids.userA1, tenantId: ids.tenantB }),
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("роль входа справочник не видит", async () => {
    const code = await errorCode(() => db().identity.select().from(membershipDirectory));
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("ID пользователя не в формате UUID — контекст не ставится", async () => {
    await expect(withUser(db().app, "not-a-uuid", () => Promise.resolve(1))).rejects.toThrow(
      TypeError,
    );
  });
});
