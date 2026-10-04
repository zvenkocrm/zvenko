import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { accounts, deals, memberships, sessions, tenants, users } from "../src/schema/index.js";
import { pgErrorCode, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

const PERMISSION_DENIED = "42501";
const CHECK_VIOLATION = "23514";

let started: TestDatabase | undefined;

function db(): TestDatabase {
  if (!started) throw new Error("тестовая БД не запущена");
  return started;
}

beforeAll(async () => {
  started = await startTestDatabase();
  await seed(started.owner);
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

describe("роль приложения не видит данные входа (ADR-0006)", () => {
  it("у роли приложения нет доступа к схеме identity", async () => {
    const result = await db().owner.execute<{ usage: boolean }>(
      sql`select has_schema_privilege('zvenko_app', 'identity', 'USAGE') as usage`,
    );
    expect(result.rows).toEqual([{ usage: false }]);
  });

  it("сессии и хэши паролей недоступны роли приложения", async () => {
    expect(await errorCode(() => db().app.select().from(sessions))).toBe(PERMISSION_DENIED);
    expect(await errorCode(() => db().app.select().from(accounts))).toBe(PERMISSION_DENIED);
  });

  it("роль приложения не создаёт пользователей", async () => {
    const code = await errorCode(() =>
      db().app.insert(users).values({ id: newId(), email: "intruder@example.test", name: "X" }),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe("роль входа не видит данные компаний", () => {
  it.each([
    ["сделки", deals],
    ["сотрудники", memberships],
    ["компании", tenants],
  ] as const)("%s недоступны", async (_name, table) => {
    expect(await errorCode(() => db().identity.select().from(table))).toBe(PERMISSION_DENIED);
  });

  it("роль входа создаёт пользователя, учётную запись и сессию", async () => {
    const userId = newId();
    await db()
      .identity.insert(users)
      .values({ id: userId, email: "new@example.test", name: "Новый" });
    await db().identity.insert(accounts).values({
      id: newId(),
      userId,
      accountId: userId,
      providerId: "credential",
      password: "hash",
    });
    await db()
      .identity.insert(sessions)
      .values({ id: newId(), userId, token: newId(), expiresAt: new Date(Date.now() + 60_000) });

    const found = await db()
      .identity.select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId));
    expect(found).toEqual([{ id: userId }]);
  });

  it("роль входа видит всех пользователей — для входа по почте", async () => {
    const rows = await db()
      .identity.select({ id: users.id })
      .from(users)
      .where(eq(users.id, ids.userB1));
    expect(rows).toEqual([{ id: ids.userB1 }]);
  });
});

describe("почта пользователя", () => {
  it("хранится только в нижнем регистре: одна почта — один пользователь", async () => {
    const code = await errorCode(() =>
      db().identity.insert(users).values({ id: newId(), email: "Mixed@Example.test", name: "X" }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });
});
