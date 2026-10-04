import { ids, seed, startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { as, createTestApp, type TestApp } from "./helpers.js";

/**
 * Тесты изоляции компаний для каждого адреса API (SEC-06).
 *
 * Реестр ниже должен совпадать с адресами приложения: новый адрес без записи роняет тест
 * «реестр совпадает с приложением». По записи генерируются проверки:
 * - для всех, кроме public, — без входа 401;
 * - read-one — объект по ID: чужой → 404, свой → 200;
 * - list — список: сотрудник компании B не видит объектов компании A, A видит свои.
 *
 * Проверка «свой виден» нужна, чтобы сломанный адрес, который всегда отвечает 404,
 * не прошёл тест изоляции.
 */
type Entry =
  { readonly kind: "public" } | { readonly kind: "list" | "read-one"; readonly entity: Entity };

/** Объекты тестовых данных: по одному у компании A и у компании B. */
const objects = {
  deal: { a: ids.dealA1, b: ids.dealB1 },
} as const;
type Entity = keyof typeof objects;

const registry: Readonly<Record<string, Entry>> = {
  "GET /health/live": { kind: "public" },
  "GET /health/ready": { kind: "public" },
  // Вход и сессии (Better Auth): без входа по определению; лишние эндпоинты выключены.
  "GET /api/auth/*": { kind: "public" },
  "POST /api/auth/*": { kind: "public" },
  "GET /api/v1/deals": { kind: "list", entity: "deal" },
  "GET /api/v1/deals/:id": { kind: "read-one", entity: "deal" },
};

/** A1 — менеджер компании A (видит свои сделки), B1 — владелец компании B (видит всё в B). */
const employeeA = as(ids.userA1, ids.tenantA);
const ownerB = as(ids.userB1, ids.tenantB);

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;

function app(): TestApp {
  if (!testApp) throw new Error("приложение не запущено");
  return testApp;
}

beforeAll(async () => {
  database = await startTestDatabase();
  await seed(database.owner);
  testApp = await createTestApp({ databaseUrl: database.appUrl, headerAuth: true });
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

async function request(
  route: string,
  headers: Record<string, string>,
  id?: string,
): Promise<{ status: number; body: unknown }> {
  const [method = "", path = ""] = route.split(" ");
  const url = id === undefined ? path : path.replace(":id", id);
  const response = await app().app.inject({ method: method as "GET", url, headers });
  return { status: response.statusCode, body: response.json<unknown>() };
}

const itemIds = (body: unknown): string[] =>
  (body as { items: { id: string }[] }).items.map((item) => item.id);

describe("реестр адресов", () => {
  it("совпадает с адресами приложения: у каждого адреса есть тест изоляции", () => {
    const actual = app()
      .routes.map((route) => `${route.method} ${route.url}`)
      .sort();
    expect(actual).toEqual(Object.keys(registry).sort());
  });
});

const protectedRoutes = Object.entries(registry).filter(([, entry]) => entry.kind !== "public");

describe.each(protectedRoutes)("%s", (route, entry) => {
  const sample = entry.kind === "public" ? undefined : objects[entry.entity];

  it("без входа — 401", async () => {
    expect((await request(route, {}, sample?.a)).status).toBe(401);
  });

  if (entry.kind === "read-one" && sample) {
    it("сотрудник компании B не видит объект компании A — 404", async () => {
      expect((await request(route, ownerB, sample.a)).status).toBe(404);
    });

    it("сотрудник компании A видит свой объект", async () => {
      const response = await request(route, employeeA, sample.a);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: sample.a });
    });
  }

  if (entry.kind === "list" && sample) {
    it("в списке компании B нет объектов компании A", async () => {
      const response = await request(route, ownerB);
      expect(response.status).toBe(200);
      expect(itemIds(response.body)).not.toContain(sample.a);
      expect(itemIds(response.body)).toContain(sample.b);
    });

    it("сотрудник компании A видит свои объекты", async () => {
      const response = await request(route, employeeA);
      expect(itemIds(response.body)).toContain(sample.a);
      expect(itemIds(response.body)).not.toContain(sample.b);
    });
  }
});
