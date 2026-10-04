import { startTestDatabase, type TestDatabase } from "@zvenko/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

let database: TestDatabase | undefined;
let testApp: TestApp | undefined;

beforeAll(async () => {
  database = await startTestDatabase();
  testApp = await createTestApp({ databaseUrl: database.appUrl });
});

afterAll(async () => {
  await testApp?.close();
  await database?.stop();
});

describe("API и настоящий PostgreSQL", () => {
  it("готовность проверяет связь с БД ролью приложения", async () => {
    if (!testApp) throw new Error("приложение не запущено");
    const response = await testApp.app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
