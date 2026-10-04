import { and, eq, memberships, newId, users } from "@zvenko/db";
import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROBLEM_TYPES } from "../src/http/problem.js";
import { as, createTestApp, tenantHost, type TestApp } from "./helpers.js";

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
  testApp = await createTestApp({ databaseUrl: database.appUrl, headerAuth: true });
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app().app.inject({ method: "GET", url, headers });

const dealIds = async (headers: Record<string, string>): Promise<string[]> => {
  const response = await get("/api/v1/deals", headers);
  expect(response.statusCode).toBe(200);
  return response
    .json<{ items: { id: string }[] }>()
    .items.map((deal) => deal.id)
    .sort();
};

const sorted = (values: string[]) => [...values].sort();

/** Меняет роль сотрудника на время теста — администратором БД, в обход RLS. */
async function withRole(userId: string, role: string, check: () => Promise<void>): Promise<void> {
  const where = and(eq(memberships.tenantId, ids.tenantA), eq(memberships.userId, userId));
  const [before] = await db()
    .admin.select({ role: memberships.role })
    .from(memberships)
    .where(where);
  await db().admin.update(memberships).set({ role }).where(where);
  try {
    await check();
  } finally {
    await db()
      .admin.update(memberships)
      .set({ role: before?.role ?? "manager" })
      .where(where);
  }
}

describe("вход по умолчанию — запрещено (SEC-05)", () => {
  it("без сессии модуля входа API не пускает никого — тестовый заголовок не действует", async () => {
    const plain = await createTestApp({ databaseUrl: db().appUrl, identityUrl: db().identityUrl });
    try {
      const response = await plain.app.inject({
        method: "GET",
        url: "/api/v1/deals",
        headers: as(ids.userA1, ids.tenantA),
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await plain.close();
    }
  });

  it("без выбранной компании — 403", async () => {
    expect((await get("/api/v1/deals", as(ids.userA1, null))).statusCode).toBe(403);
  });

  it("в чужой компании — 403: сессия не даёт доступа туда, где пользователь не работает", async () => {
    expect((await get("/api/v1/deals", as(ids.userB1, ids.tenantA))).statusCode).toBe(403);
  });
});

describe("компания по адресу сайта (F-AUTH-06)", () => {
  const onHost = (host: string, headers: Record<string, string>) =>
    app().app.inject({ method: "GET", url: "/api/v1/deals", headers: { host, ...headers } });

  it("адрес компании задаёт компанию, даже если в сессии она не выбрана", async () => {
    const response = await onHost(tenantHost("company-a"), as(ids.userA1, null));
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([
      ids.dealA1,
    ]);
  });

  it("адрес важнее компании, выбранной в сессии: сотрудник B на адресе A — 403", async () => {
    const response = await onHost(tenantHost("company-a"), as(ids.userB1, ids.tenantB));
    expect(response.statusCode).toBe(403);
  });

  it("неизвестный поддомен — 404", async () => {
    const response = await onHost(tenantHost("no-such-company"), as(ids.userA1, ids.tenantA));
    expect(response.statusCode).toBe(404);
  });

  it("без входа — 401 на любом поддомене: есть ли там компания, не раскрывается", async () => {
    expect((await onHost(tenantHost("no-such-company"), {})).statusCode).toBe(401);
    expect((await onHost(tenantHost("company-a"), {})).statusCode).toBe(401);
  });

  it("служебный поддомен (app) — не компания: берётся выбранная в сессии", async () => {
    const response = await onHost(tenantHost("app"), as(ids.userA1, ids.tenantA));
    expect(response.statusCode).toBe(200);
  });
});

describe("2FA по ролям (SEC-02)", () => {
  it("владелец без 2FA — 403 с типом two-factor-required", async () => {
    const response = await get("/api/v1/deals", as(ids.userB1, ids.tenantB, { twoFactor: false }));
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ type: PROBLEM_TYPES.twoFactorRequired });
  });

  it("администратор без 2FA — тоже 403", async () => {
    await withRole(ids.userA3, "admin", async () => {
      const response = await get(
        "/api/v1/deals",
        as(ids.userA3, ids.tenantA, { twoFactor: false }),
      );
      expect(response.statusCode).toBe(403);
    });
  });

  it.each(["manager", "head"])("роль %s работает без 2FA", async (role) => {
    await withRole(ids.userA2, role, async () => {
      const response = await get(
        "/api/v1/deals",
        as(ids.userA2, ids.tenantA, { twoFactor: false }),
      );
      expect(response.statusCode).toBe(200);
    });
  });
});

describe("области видимости ролей (F-USR-03)", () => {
  it("менеджер видит только свои сделки", async () => {
    expect(await dealIds(as(ids.userA1, ids.tenantA))).toEqual([ids.dealA1]);
  });

  it("сделка коллеги для менеджера — 404, как несуществующая", async () => {
    const response = await get(`/api/v1/deals/${ids.dealA2}`, as(ids.userA1, ids.tenantA));
    expect(response.statusCode).toBe(404);
  });

  it("руководитель видит сделки своего отдела", async () => {
    await withRole(ids.userA2, "head", async () => {
      expect(await dealIds(as(ids.userA2, ids.tenantA))).toEqual(sorted([ids.dealA1, ids.dealA2]));
    });
  });

  it("администратор видит все сделки компании", async () => {
    await withRole(ids.userA3, "admin", async () => {
      expect(await dealIds(as(ids.userA3, ids.tenantA))).toEqual(
        sorted([ids.dealA1, ids.dealA2, ids.dealA3]),
      );
    });
  });

  it("неизвестная роль — доступ закрыт, в логе предупреждение", async () => {
    await withRole(ids.userA1, "superuser", async () => {
      const response = await get("/api/v1/deals", as(ids.userA1, ids.tenantA));
      expect(response.statusCode).toBe(403);
    });
    expect(
      app()
        .logs()
        .some((line) => line.msg === "неизвестная роль сотрудника — доступ закрыт"),
    ).toBe(true);
  });
});

describe("изменения прав действуют сразу (F-USR-05, F-USR-06)", () => {
  it("отключённый сотрудник теряет доступ на следующем запросе", async () => {
    const userId = newId();
    await db()
      .admin.insert(users)
      .values({ id: userId, email: `${userId}@example.test`, name: "Новый" });
    await db()
      .admin.insert(memberships)
      .values({ tenantId: ids.tenantA, userId, teamId: ids.teamA1, role: "manager" });

    expect((await get("/api/v1/deals", as(userId, ids.tenantA))).statusCode).toBe(200);

    await db()
      .admin.delete(memberships)
      .where(and(eq(memberships.tenantId, ids.tenantA), eq(memberships.userId, userId)));

    expect((await get("/api/v1/deals", as(userId, ids.tenantA))).statusCode).toBe(403);
  });
});

describe("проверка входных данных", () => {
  it("ID сделки не в формате UUID — 400", async () => {
    const response = await get("/api/v1/deals/42", as(ids.userA1, ids.tenantA));
    expect(response.statusCode).toBe(400);
  });
});
