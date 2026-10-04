import { eq, memberships, sessions, sql, twoFactors, users } from "@zvenko/db";
import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROBLEM_TYPES } from "../src/http/problem.js";
import { IdentityService } from "../src/identity/identity.service.js";
import { createTestApp, TEST_HOST, TEST_ORIGIN, type TestApp } from "./helpers.js";
import { secretFromUri, totp } from "./totp.js";

const PASSWORD = "правильная лошадь батарейка";
const OWNER = "boris@example.test";
const MANAGER = "vera@example.test";

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;
let ownerId = "";
let managerId = "";

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
    identityUrl: database.identityUrl,
  });
  const identity = testApp.app.get(IdentityService);
  ({ id: ownerId } = await identity.createUser({
    email: OWNER,
    name: "Борис",
    password: PASSWORD,
  }));
  ({ id: managerId } = await identity.createUser({
    email: MANAGER,
    name: "Вера",
    password: PASSWORD,
  }));
  await database.admin.insert(memberships).values([
    { tenantId: ids.tenantA, userId: ownerId, teamId: ids.teamA1, role: "owner" },
    { tenantId: ids.tenantA, userId: managerId, teamId: ids.teamA1, role: "manager" },
  ]);
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

// Свой IP на каждый запрос ко входу: лимиты по IP не должны мешать проверкам логики.
let lastIp = 0;
const nextIp = (): string => `10.1.0.${String(++lastIp)}`;

function post(url: string, body: object, cookie?: string): Promise<LightMyRequestResponse> {
  return app().app.inject({
    method: "POST",
    url,
    remoteAddress: nextIp(),
    headers: {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      "content-type": "application/json",
      ...(cookie === undefined ? {} : { cookie }),
    },
    payload: JSON.stringify(body),
  });
}

/**
 * Cookie ответа по имени, в виде «имя=значение» для следующего запроса.
 * Пустое значение — это стирание cookie, а не выдача: такое считаем отсутствием.
 */
function cookie(response: LightMyRequestResponse, name: string): string | undefined {
  const raw = response.headers["set-cookie"];
  const all = raw === undefined ? [] : [raw].flat();
  const pair = all.find((c) => c.startsWith(`${name}=`))?.split(";")[0];
  return pair === undefined || pair === `${name}=` ? undefined : pair;
}

function requireCookie(response: LightMyRequestResponse, name: string): string {
  const value = cookie(response, name);
  if (!value) throw new Error(`нет cookie ${name}`);
  return value;
}

const signIn = (email: string) => post("/api/auth/sign-in/email", { email, password: PASSWORD });

/** Сессия получает компанию A — выбор компании появится отдельным эндпоинтом. */
async function selectTenantA(userId: string): Promise<void> {
  await db()
    .admin.update(sessions)
    .set({ activeTenantId: ids.tenantA })
    .where(eq(sessions.userId, userId));
}

const getDeals = (sessionCookie: string) =>
  app().app.inject({
    method: "GET",
    url: "/api/v1/deals",
    headers: { host: TEST_HOST, cookie: sessionCookie },
  });

async function resetLockout(userId: string): Promise<void> {
  await db()
    .admin.update(twoFactors)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(eq(twoFactors.userId, userId));
}

let secret = "";
let backupCodes: string[] = [];

describe("2FA обязательна для владельца и администраторов (SEC-02)", () => {
  it("владелец без 2FA не видит данных компании — 403 с типом two-factor-required", async () => {
    const session = requireCookie(await signIn(OWNER), "zv.session_token");
    await selectTenantA(ownerId);
    const response = await getDeals(session);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ type: PROBLEM_TYPES.twoFactorRequired });
  });

  it("менеджеру 2FA не обязательна", async () => {
    const session = requireCookie(await signIn(MANAGER), "zv.session_token");
    await selectTenantA(managerId);
    expect((await getDeals(session)).statusCode).toBe(200);
  });
});

describe("включение 2FA (F-AUTH-05)", () => {
  it("по паролю: ссылка для приложения и 10 резервных кодов; работает после подтверждения кодом", async () => {
    const session = requireCookie(await signIn(OWNER), "zv.session_token");
    const enabled = await post("/api/auth/two-factor/enable", { password: PASSWORD }, session);
    expect(enabled.statusCode).toBe(200);
    const body = enabled.json<{ totpURI: string; backupCodes: string[] }>();
    secret = secretFromUri(body.totpURI);
    backupCodes = body.backupCodes;
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(backupCodes).toHaveLength(10);

    // Пока код из приложения не подтверждён, 2FA не включена.
    const [before] = await db()
      .admin.select({ on: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, ownerId));
    expect(before?.on).toBe(false);

    const verified = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      session,
    );
    expect(verified.statusCode).toBe(200);
    const [after] = await db()
      .admin.select({ on: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, ownerId));
    expect(after?.on).toBe(true);
  });

  it("секрет и резервные коды хранятся зашифрованными", async () => {
    const [row] = await db()
      .admin.select({ secret: twoFactors.secret, codes: twoFactors.backupCodes })
      .from(twoFactors)
      .where(eq(twoFactors.userId, ownerId));
    expect(row?.secret).not.toContain(secret);
    for (const code of backupCodes) expect(row?.codes).not.toContain(code);
  });
});

describe("вход с 2FA", () => {
  it("после пароля — только временная cookie второго шага; сессия — после кода", async () => {
    const first = await signIn(OWNER);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect(cookie(first, "zv.session_token")).toBeUndefined();

    const challenge = requireCookie(first, "zv.two_factor");
    const second = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      challenge,
    );
    expect(second.statusCode).toBe(200);
    const session = requireCookie(second, "zv.session_token");
    await selectTenantA(ownerId);
    expect((await getDeals(session)).statusCode).toBe(200);
  });

  it("резервный код заменяет приложение — но только один раз", async () => {
    const [code] = backupCodes;
    const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
    const used = await post("/api/auth/two-factor/verify-backup-code", { code }, challenge);
    expect(used.statusCode).toBe(200);
    expect(cookie(used, "zv.session_token")).toBeDefined();

    const again = requireCookie(await signIn(OWNER), "zv.two_factor");
    const reused = await post("/api/auth/two-factor/verify-backup-code", { code }, again);
    expect(reused.statusCode).not.toBe(200);
    expect(cookie(reused, "zv.session_token")).toBeUndefined();
    await resetLockout(ownerId);
  });

  it("«доверенное устройство» отключено: второй фактор нужен при каждом входе", async () => {
    const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
    const response = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret), trustDevice: true },
      challenge,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "TRUSTED_DEVICES_DISABLED" });
    expect(cookie(response, "zv.session_token")).toBeUndefined();
    expect(cookie(response, "zv.trust_device")).toBeUndefined();
  });

  it("пять неверных кодов подряд — вход блокируется, даже верный код не проходит", async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
      const wrong = await post("/api/auth/two-factor/verify-totp", { code: "000000" }, challenge);
      expect(wrong.statusCode).not.toBe(200);
    }
    const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
    const locked = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      challenge,
    );
    expect(locked.statusCode).toBe(429);
    expect(cookie(locked, "zv.session_token")).toBeUndefined();
    await resetLockout(ownerId);
  });

  it("коды по почте выключены — только приложение и резервные коды", async () => {
    const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
    expect((await post("/api/auth/two-factor/send-otp", {}, challenge)).statusCode).toBe(404);
  });
});

describe("отключение 2FA", () => {
  it("требует пароль; после отключения владелец снова теряет доступ к данным", async () => {
    const challenge = requireCookie(await signIn(OWNER), "zv.two_factor");
    const signedIn = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      challenge,
    );
    const session = requireCookie(signedIn, "zv.session_token");

    const wrong = await post(
      "/api/auth/two-factor/disable",
      { password: "не тот пароль" },
      session,
    );
    expect(wrong.statusCode).not.toBe(200);

    const disabled = await post("/api/auth/two-factor/disable", { password: PASSWORD }, session);
    expect(disabled.statusCode).toBe(200);

    // Новая сессия без 2FA: данные компании закрыты.
    const fresh = requireCookie(await signIn(OWNER), "zv.session_token");
    await selectTenantA(ownerId);
    const response = await getDeals(fresh);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ type: PROBLEM_TYPES.twoFactorRequired });
  });

  it("таблица 2FA не хранит лишнего: после отключения записи нет", async () => {
    const rows = await db().admin.execute<{ count: number }>(
      sql`select count(*)::int as count from identity.two_factors where user_id = ${ownerId}`,
    );
    expect(rows.rows).toEqual([{ count: 0 }]);
  });
});
