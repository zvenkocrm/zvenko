import type { LightMyRequestResponse } from "fastify";
import { accounts, deals, eq, memberships, newId, sessions, sql, users } from "@zvenko/db";
import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IdentityService } from "../src/identity/identity.service.js";
import { createTestApp, TEST_HOST, TEST_ORIGIN, type TestApp } from "./helpers.js";

const EMAIL = "anna@example.test";
const PASSWORD = "правильная лошадь батарейка";

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;
let annaId = "";
const annaDeal = newId();

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
  await seed(database.owner);
  testApp = await createTestApp({
    databaseUrl: database.appUrl,
    identityUrl: database.identityUrl,
  });

  // Сотрудник компании A с паролем: создаёт модуль входа, членство и сделку — владелец схемы.
  ({ id: annaId } = await testApp.app
    .get(IdentityService)
    .createUser({ email: "Anna@Example.test", name: "Анна", password: PASSWORD }));
  await database.owner
    .insert(memberships)
    .values({ tenantId: ids.tenantA, userId: annaId, teamId: ids.teamA1, role: "manager" });
  await database.owner.insert(deals).values({
    tenantId: ids.tenantA,
    id: annaDeal,
    title: "Макет моста",
    ownerId: annaId,
    teamId: ids.teamA1,
  });
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

// У каждого входа свой IP: лимит попыток считается по IP (SEC-04) и не должен мешать тестам.
let lastIp = 0;
const nextIp = (): string => `10.0.0.${String(++lastIp)}`;

function signIn(
  email: string,
  password: string,
  options: { ip?: string; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return app().app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    remoteAddress: options.ip ?? nextIp(),
    headers: {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      ...options.headers,
    },
    payload: JSON.stringify({ email, password }),
  });
}

function setCookies(response: LightMyRequestResponse): string[] {
  const raw = response.headers["set-cookie"];
  return raw === undefined ? [] : [raw].flat();
}

/** Значение cookie сессии в виде «имя=значение» для следующих запросов. */
function sessionCookie(response: LightMyRequestResponse): string {
  const cookie = setCookies(response).find((c) => c.startsWith("zv.session_token="));
  if (!cookie) throw new Error("нет cookie сессии");
  return cookie.split(";")[0] ?? "";
}

const getDeals = (cookie: string) =>
  app().app.inject({ method: "GET", url: "/api/v1/deals", headers: { host: TEST_HOST, cookie } });

/** Последняя сессия Анны — напрямую из БД, ролью-владельцем. */
async function latestSession() {
  const [row] = await db()
    .owner.select()
    .from(sessions)
    .where(eq(sessions.userId, annaId))
    .orderBy(sql`${sessions.createdAt} desc`)
    .limit(1);
  if (!row) throw new Error("сессия не найдена");
  return row;
}

describe("вход по почте и паролю (F-AUTH-01)", () => {
  it("успешный вход ставит cookie HttpOnly и SameSite=Lax; в ответе нет хэша пароля", async () => {
    const response = await signIn("ANNA@example.test", PASSWORD);
    expect(response.statusCode).toBe(200);
    const cookie = setCookies(response).find((c) => c.startsWith("zv.session_token="));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain(EMAIL);
    expect(response.body).not.toMatch(/argon2|password/i);
  });

  it("неверный пароль и неизвестная почта — один и тот же ответ (SEC-04)", async () => {
    const wrongPassword = await signIn(EMAIL, "не тот пароль совсем");
    const unknownEmail = await signIn("nobody@example.test", "не тот пароль совсем");
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json()).toEqual(wrongPassword.json());
    expect(setCookies(wrongPassword).some((c) => c.startsWith("zv.session_token="))).toBe(false);
  });

  it("пароль хранится только как хэш argon2id", async () => {
    const [account] = await db()
      .owner.select({ password: accounts.password })
      .from(accounts)
      .where(eq(accounts.userId, annaId));
    expect(account?.password?.startsWith("$argon2id$")).toBe(true);
    expect(account?.password).not.toContain(PASSWORD);
  });

  it("IP в сессии — тот, что увидел сервер: подделка заголовков не помогает", async () => {
    const response = await signIn(EMAIL, PASSWORD, {
      ip: "10.9.9.9",
      headers: {
        "x-forwarded-for": "6.6.6.6",
        "x-zvenko-client-ip": "7.7.7.7",
        "x-real-ip": "8.8.8.8",
      },
    });
    expect(response.statusCode).toBe(200);
    expect((await latestSession()).ipAddress).toBe("10.9.9.9");
  });
});

describe("закрытая система (D15)", () => {
  it("регистрации нет: пользователи появляются только по приглашению", async () => {
    const response = await app().app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      remoteAddress: nextIp(),
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, "content-type": "application/json" },
      payload: JSON.stringify({ email: "new@example.test", password: PASSWORD, name: "Новый" }),
    });
    expect(response.statusCode).toBe(404);
    const created = await db()
      .owner.select()
      .from(users)
      .where(eq(users.email, "new@example.test"));
    expect(created).toEqual([]);
  });

  it.each([
    ["POST", "/api/auth/request-password-reset"],
    ["POST", "/api/auth/update-user"],
    ["POST", "/api/auth/delete-user"],
    ["GET", "/api/auth/list-accounts"],
  ] as const)("неиспользуемый эндпоинт %s %s выключен", async (method, url) => {
    const response = await app().app.inject({
      method,
      url,
      remoteAddress: nextIp(),
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, "content-type": "application/json" },
      ...(method === "POST" ? { payload: "{}" } : {}),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("сессия в API", () => {
  it("без выбранной компании — 403; со своей компанией — свои сделки", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    expect((await getDeals(cookie)).statusCode).toBe(403);

    const session = await latestSession();
    await db()
      .owner.update(sessions)
      .set({ activeTenantId: ids.tenantA })
      .where(eq(sessions.id, session.id));

    const response = await getDeals(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([annaDeal]);
  });

  it("компания, где пользователь не работает, — 403", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    const session = await latestSession();
    await db()
      .owner.update(sessions)
      .set({ activeTenantId: ids.tenantB })
      .where(eq(sessions.id, session.id));
    expect((await getDeals(cookie)).statusCode).toBe(403);
  });

  it("простой дольше срока — сессия недействительна", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    const session = await latestSession();
    await db()
      .owner.update(sessions)
      .set({ activeTenantId: ids.tenantA, expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(sessions.id, session.id));
    expect((await getDeals(cookie)).statusCode).toBe(401);
  });

  it("абсолютный срок 30 дней — сессия завершается и удаляется (D20)", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    const session = await latestSession();
    await db()
      .owner.update(sessions)
      .set({ activeTenantId: ids.tenantA, createdAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      .where(eq(sessions.id, session.id));

    expect((await getDeals(cookie)).statusCode).toBe(401);
    const left = await db().owner.select().from(sessions).where(eq(sessions.id, session.id));
    expect(left).toEqual([]);
  });

  it("выход завершает сессию", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    const session = await latestSession();
    await db()
      .owner.update(sessions)
      .set({ activeTenantId: ids.tenantA })
      .where(eq(sessions.id, session.id));
    expect((await getDeals(cookie)).statusCode).toBe(200);

    const signOut = await app().app.inject({
      method: "POST",
      url: "/api/auth/sign-out",
      remoteAddress: nextIp(),
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie, "content-type": "application/json" },
      payload: "{}",
    });
    expect(signOut.statusCode).toBe(200);
    expect((await getDeals(cookie)).statusCode).toBe(401);
  });
});

describe("выбор компании в сессии (F-AUTH-06)", () => {
  const selectTenant = (cookie: string, tenantId: string) =>
    app().app.inject({
      method: "PUT",
      url: "/api/v1/session/tenant",
      remoteAddress: nextIp(),
      headers: { host: TEST_HOST, origin: TEST_ORIGIN, cookie, "content-type": "application/json" },
      payload: JSON.stringify({ tenantId }),
    });

  it("своя компания: 204, и данные компании доступны", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    expect((await getDeals(cookie)).statusCode).toBe(403);

    expect((await selectTenant(cookie, ids.tenantA)).statusCode).toBe(204);
    const response = await getDeals(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { id: string }[] }>().items.map((d) => d.id)).toEqual([annaDeal]);
  });

  it("чужая компания — 404, как несуществующая; выбор не меняется", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    expect((await selectTenant(cookie, ids.tenantA)).statusCode).toBe(204);

    expect((await selectTenant(cookie, ids.tenantB)).statusCode).toBe(404);
    expect((await selectTenant(cookie, newId())).statusCode).toBe(404);
    expect((await latestSession()).activeTenantId).toBe(ids.tenantA);
  });

  it("ID компании не в формате UUID — 400", async () => {
    const cookie = sessionCookie(await signIn(EMAIL, PASSWORD));
    expect((await selectTenant(cookie, "neva")).statusCode).toBe(400);
  });
});

describe("защита входа", () => {
  it("перебор пароля: шестая попытка за минуту с одного IP — 429 (SEC-04)", async () => {
    const ip = nextIp();
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect((await signIn(EMAIL, `неверный пароль ${String(attempt)}`, { ip })).statusCode).toBe(
        401,
      );
    }
    expect((await signIn(EMAIL, PASSWORD, { ip })).statusCode).toBe(429);
  });

  it("вход с чужого сайта отклоняется (CSRF, SEC-10)", async () => {
    const response = await signIn(EMAIL, PASSWORD, {
      headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("создание пользователя на сервере", () => {
  const service = (): IdentityService => app().app.get(IdentityService);

  it("пароль короче 12 символов не принимается (SEC-01)", async () => {
    await expect(
      service().createUser({
        email: "short@example.test",
        name: "Коротко",
        password: "12345678901",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("почта сохраняется в нижнем регистре и подтверждённой", async () => {
    const [row] = await db()
      .owner.select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, annaId));
    expect(row).toEqual({ email: EMAIL, verified: true });
  });
});
