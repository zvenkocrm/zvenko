import {
  and,
  asc,
  auditLog,
  eq,
  gt,
  memberships,
  sessions,
  sql,
  twoFactors,
  verifyAuditLog,
} from "@zvenko/db";
import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthEvents } from "../src/identity/auth-events.js";
import { IdentityService } from "../src/identity/identity.service.js";
import { createTestApp, TEST_HOST, tenantHost, type TestApp } from "./helpers.js";
import { secretFromUri, totp } from "./totp.js";

/**
 * События входа в журналах аудита (F-AUD-01, D30). Анна работает в компании A,
 * Борис и Вера — в A и B.
 */
const PASSWORD = "правильная лошадь батарейка";
const NEW_PASSWORD = "другая лошадь батарейка скрепка";
const ANNA = "anna@example.test";
const BORIS = "boris@example.test";
const VERA = "vera@example.test";
const HOST_A = tenantHost("company-a");

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;
let annaId = "";
let borisId = "";
let veraId = "";

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
  ({ id: annaId } = await identity.createUser({ email: ANNA, name: "Анна", password: PASSWORD }));
  ({ id: borisId } = await identity.createUser({
    email: BORIS,
    name: "Борис",
    password: PASSWORD,
  }));
  ({ id: veraId } = await identity.createUser({ email: VERA, name: "Вера", password: PASSWORD }));
  await database.admin.insert(memberships).values([
    { tenantId: ids.tenantA, userId: annaId, teamId: ids.teamA1, role: "manager" },
    { tenantId: ids.tenantA, userId: borisId, teamId: ids.teamA1, role: "manager" },
    { tenantId: ids.tenantB, userId: borisId, teamId: ids.teamB1, role: "manager" },
    { tenantId: ids.tenantA, userId: veraId, teamId: ids.teamA1, role: "manager" },
    { tenantId: ids.tenantB, userId: veraId, teamId: ids.teamB1, role: "manager" },
  ]);
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

// Свой IP на каждый запрос ко входу: лимиты по IP не должны мешать проверкам.
let lastIp = 0;
const nextIp = (): string => `10.2.0.${String(++lastIp)}`;

interface RequestOptions {
  readonly host?: string;
  readonly cookie?: string;
  readonly ip?: string;
  readonly headers?: Record<string, string>;
  readonly target?: TestApp;
}

function send(
  method: "POST" | "PUT",
  url: string,
  body: object,
  options: RequestOptions = {},
): Promise<LightMyRequestResponse> {
  const host = options.host ?? TEST_HOST;
  return (options.target ?? app()).app.inject({
    method,
    url,
    remoteAddress: options.ip ?? nextIp(),
    headers: {
      host,
      origin: `http://${host}`,
      "content-type": "application/json",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    payload: JSON.stringify(body),
  });
}

const post = (url: string, body: object, options?: RequestOptions) =>
  send("POST", url, body, options);

const signIn = (email: string, options?: RequestOptions, password = PASSWORD) =>
  post("/api/auth/sign-in/email", { email, password }, options);

/** Cookie ответа «имя=значение». Пустое значение — стирание cookie, его не считаем. */
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

async function latestSession(userId: string) {
  const [row] = await db()
    .admin.select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(sql`${sessions.createdAt} desc`)
    .limit(1);
  if (!row) throw new Error("сессия не найдена");
  return row;
}

async function resetLockout(userId: string): Promise<void> {
  await db()
    .admin.update(twoFactors)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(eq(twoFactors.userId, userId));
}

/** Последние номера записей в журналах компаний — отметка «до действия». */
async function marks(): Promise<{ a: number; b: number }> {
  await app().app.get(AuthEvents).settled();
  const last = async (tenantId: string) => {
    const [row] = await db()
      .admin.select({ seq: sql<number>`coalesce(max(${auditLog.seq}), 0)::int` })
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantId));
    return row?.seq ?? 0;
  };
  return { a: await last(ids.tenantA), b: await last(ids.tenantB) };
}

/** Записи журнала компании после отметки — дождавшись фоновых записей. */
async function recordsAfter(tenantId: string, seq: number) {
  await app().app.get(AuthEvents).settled();
  return db()
    .admin.select()
    .from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), gt(auditLog.seq, seq)))
    .orderBy(asc(auditLog.seq));
}

describe("вход и выход — в журнал компании, куда вошёл (D30)", () => {
  it("вход на адресе компании: «Вход» — кто, откуда, какая сессия; в другой компании пусто", async () => {
    const mark = await marks();
    const ip = nextIp();
    // Подделка служебных заголовков не меняет IP и ID запроса в журнале.
    const forged = { "x-zvenko-client-ip": "203.0.113.9", "x-zvenko-request-id": "forged-request" };
    const response = await signIn(ANNA, { host: HOST_A, ip, headers: forged });
    expect(response.statusCode).toBe(200);

    const session = await latestSession(annaId);
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([
      {
        action: "auth.sign_in",
        result: "success",
        actorType: "user",
        actorId: annaId,
        objectType: "session",
        objectId: session.id,
        ip,
        userAgent: "lightMyRequest",
        requestId: response.headers["x-request-id"],
      },
    ]);
    expect(await recordsAfter(ids.tenantB, mark.b)).toEqual([]);
  });

  it("вход на общем адресе — записи нет: вход в компанию запишется при её выборе", async () => {
    const mark = await marks();
    expect((await signIn(ANNA)).statusCode).toBe(200);
    expect(await recordsAfter(ids.tenantA, mark.a)).toEqual([]);
  });

  it("выход на адресе компании — «Выход» в её журнал", async () => {
    const session = requireCookie(await signIn(ANNA, { host: HOST_A }), "zv.session_token");
    const { id: sessionId } = await latestSession(annaId);
    const mark = await marks();
    expect(
      (await post("/api/auth/sign-out", {}, { host: HOST_A, cookie: session })).statusCode,
    ).toBe(200);
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([
      { action: "auth.sign_out", actorId: annaId, objectId: sessionId },
    ]);
  });

  it("выход на общем адресе — в журнал компании, выбранной в сессии", async () => {
    const session = requireCookie(await signIn(ANNA), "zv.session_token");
    const selected = await send(
      "PUT",
      "/api/v1/session/tenant",
      { tenantId: ids.tenantA },
      { cookie: session },
    );
    expect(selected.statusCode).toBe(204);
    const mark = await marks();
    expect((await post("/api/auth/sign-out", {}, { cookie: session })).statusCode).toBe(200);
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([
      { action: "auth.sign_out", actorId: annaId },
    ]);
  });
});

describe("неудачные попытки входа — в журналы всех компаний сотрудника (D30)", () => {
  it("неверный пароль: запись в обеих компаниях Бориса; кто — неизвестный", async () => {
    const mark = await marks();
    expect((await signIn(BORIS, {}, "не тот пароль")).statusCode).toBe(401);
    const expected = {
      action: "auth.sign_in",
      result: "failure",
      actorType: "anonymous",
      actorId: null,
      objectType: "user",
      objectId: borisId,
      details: { reason: "password" },
    };
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([expected]);
    expect(await recordsAfter(ids.tenantB, mark.b)).toMatchObject([expected]);
  });

  it("неизвестная почта: тот же ответ, записей нет", async () => {
    const known = await signIn(BORIS, {}, "не тот пароль");
    const mark = await marks();
    const unknown = await signIn("nobody@example.test", {}, "не тот пароль");
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(await recordsAfter(ids.tenantA, mark.a)).toEqual([]);
    expect(await recordsAfter(ids.tenantB, mark.b)).toEqual([]);
  });
});

describe("2FA и вход с ней", () => {
  let secret = "";

  it("включение 2FA — в журналы обеих компаний Бориса", async () => {
    const session = requireCookie(await signIn(BORIS), "zv.session_token");
    const mark = await marks();
    const enabled = await post(
      "/api/auth/two-factor/enable",
      { password: PASSWORD },
      { cookie: session },
    );
    secret = secretFromUri(enabled.json<{ totpURI: string }>().totpURI);
    const verified = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      { cookie: session },
    );
    expect(verified.statusCode).toBe(200);
    const expected = { action: "auth.two_factor_enabled", actorType: "user", actorId: borisId };
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([expected]);
    expect(await recordsAfter(ids.tenantB, mark.b)).toMatchObject([expected]);
  });

  it("после пароля входа ещё нет; неверный код — неудачная попытка; верный — вход", async () => {
    const mark = await marks();
    const first = await signIn(BORIS, { host: HOST_A });
    expect(first.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await recordsAfter(ids.tenantA, mark.a)).toEqual([]);

    const challenge = requireCookie(first, "zv.two_factor");
    const wrong = await post(
      "/api/auth/two-factor/verify-totp",
      { code: "000000" },
      { host: HOST_A, cookie: challenge },
    );
    expect(wrong.statusCode).not.toBe(200);
    await app().app.get(AuthEvents).settled();
    const right = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      { host: HOST_A, cookie: challenge },
    );
    expect(right.statusCode).toBe(200);

    const failure = {
      action: "auth.sign_in",
      result: "failure",
      objectId: borisId,
      details: { reason: "second_factor" },
    };
    expect(await recordsAfter(ids.tenantA, mark.a)).toMatchObject([
      failure,
      { action: "auth.sign_in", result: "success", actorId: borisId, objectType: "session" },
    ]);
    // Вход был в компанию A — в журнале B только неудачная попытка.
    expect(await recordsAfter(ids.tenantB, mark.b)).toMatchObject([failure]);
  });

  it("пять неверных кодов подряд — блокировка аккаунта: одна запись в каждой компании", async () => {
    const mark = await marks();
    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const challenge = requireCookie(await signIn(BORIS), "zv.two_factor");
        await post("/api/auth/two-factor/verify-totp", { code: "000000" }, { cookie: challenge });
      }
      const challenge = requireCookie(await signIn(BORIS), "zv.two_factor");
      const locked = await post(
        "/api/auth/two-factor/verify-totp",
        { code: totp(secret) },
        { cookie: challenge },
      );
      expect(locked.statusCode).toBe(429);

      for (const [tenantId, seq] of [
        [ids.tenantA, mark.a],
        [ids.tenantB, mark.b],
      ] as const) {
        const rows = await recordsAfter(tenantId, seq);
        const locks = rows.filter((row) => row.action === "auth.account_locked");
        expect(locks).toMatchObject([{ actorType: "system", objectId: borisId }]);
        const reasons = rows
          .filter((row) => row.action === "auth.sign_in")
          .map((row) => (row.details as { reason: string }).reason)
          .sort();
        expect(reasons).toEqual(["locked", ...Array<string>(5).fill("second_factor")]);
      }
    } finally {
      // Даже если проверка упала: заблокированный Борис сломал бы следующие тесты.
      await resetLockout(borisId);
    }
  });

  it("новые резервные коды и отключение 2FA — в журналы обеих компаний", async () => {
    const challenge = requireCookie(await signIn(BORIS), "zv.two_factor");
    const signedIn = await post(
      "/api/auth/two-factor/verify-totp",
      { code: totp(secret) },
      { cookie: challenge },
    );
    const session = requireCookie(signedIn, "zv.session_token");
    const mark = await marks();

    const codes = await post(
      "/api/auth/two-factor/generate-backup-codes",
      { password: PASSWORD },
      { cookie: session },
    );
    expect(codes.statusCode).toBe(200);
    const disabled = await post(
      "/api/auth/two-factor/disable",
      { password: PASSWORD },
      { cookie: session },
    );
    expect(disabled.statusCode).toBe(200);

    for (const [tenantId, seq] of [
      [ids.tenantA, mark.a],
      [ids.tenantB, mark.b],
    ] as const) {
      const actions = (await recordsAfter(tenantId, seq)).map((row) => row.action);
      expect(actions).toEqual(["auth.backup_codes_generated", "auth.two_factor_disabled"]);
    }
  });
});

describe("пароль и сессии — в журналы всех компаний (D30)", () => {
  it("смена пароля и завершение других сессий", async () => {
    const session = requireCookie(await signIn(VERA), "zv.session_token");
    const mark = await marks();
    const changed = await post(
      "/api/auth/change-password",
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      { cookie: session },
    );
    expect(changed.statusCode).toBe(200);
    await app().app.get(AuthEvents).settled();
    const revoked = await post("/api/auth/revoke-other-sessions", {}, { cookie: session });
    expect(revoked.statusCode).toBe(200);

    for (const [tenantId, seq] of [
      [ids.tenantA, mark.a],
      [ids.tenantB, mark.b],
    ] as const) {
      expect(await recordsAfter(tenantId, seq)).toMatchObject([
        { action: "auth.password_changed", actorId: veraId, objectId: veraId },
        { action: "auth.sessions_revoked", actorId: veraId, details: { scope: "others" } },
      ]);
    }
  });
});

describe("без записи нет входа", () => {
  it("запись о входе не удалась — вход отменён, сессии нет", async () => {
    const failing = await createTestApp({
      databaseUrl: db().appUrl,
      identityUrl: db().identityUrl,
      override: (builder) =>
        builder.overrideProvider(AuthEvents).useValue({
          signedIn: () => Promise.reject(new Error("журнал недоступен")),
          record: () => undefined,
          settled: () => Promise.resolve(),
        }),
    });
    try {
      const before = await latestSession(annaId);
      const response = await signIn(ANNA, { host: HOST_A, target: failing });
      expect(response.statusCode).toBe(500);
      // Сессия, созданная до записи в журнал, удалена.
      expect((await latestSession(annaId)).id).toBe(before.id);
    } finally {
      await failing.close();
    }
  });
});

describe("целостность журналов", () => {
  it("цепочки хэшей обеих компаний целы после всех событий", async () => {
    await app().app.get(AuthEvents).settled();
    expect(await verifyAuditLog(db().admin, ids.tenantA)).toMatchObject({ ok: true });
    expect(await verifyAuditLog(db().admin, ids.tenantB)).toMatchObject({ ok: true });
  });
});
