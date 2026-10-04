import { Body, Controller, Get, HttpStatus, Post } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { DATABASE } from "../src/database/database.module.js";
import { ProblemException } from "../src/http/problem.js";
import { Public } from "../src/tenancy/access.js";
import { createTestApp, type TestApp } from "./helpers.js";

const dealSchema = z.object({
  title: z.string().min(1).max(200),
  amount: z.number().int().nonnegative(),
});

/** Адреса только для тестов: проверка данных, внутренняя ошибка, ошибка с пояснением. */
@Public()
@Controller({ path: "test", version: "1" })
class ProbeController {
  @Post("deals")
  create(
    @Body({ schema: dealSchema }) body: z.infer<typeof dealSchema>,
  ): z.infer<typeof dealSchema> {
    return body;
  }

  @Get("boom")
  boom(): never {
    throw new Error("пароль базы: s3cr3t-value");
  }

  @Get("conflict")
  conflict(): never {
    throw new ProblemException(HttpStatus.CONFLICT, "Поддомен уже занят");
  }
}

let testApp: TestApp | undefined;
let dbUp = true;

function app(): TestApp {
  if (!testApp) throw new Error("приложение не запущено");
  return testApp;
}

beforeAll(async () => {
  testApp = await createTestApp({
    controllers: [ProbeController],
    override: (builder) =>
      builder.overrideProvider(DATABASE).useValue({
        execute: () => (dbUp ? Promise.resolve([]) : Promise.reject(new Error("нет связи"))),
      }),
  });
});

afterAll(async () => {
  await testApp?.close();
});

const inject = (options: Parameters<TestApp["app"]["inject"]>[0]) => app().app.inject(options);

describe("заголовки безопасности (SEC-10)", () => {
  it("ответ API нельзя встроить в страницу или исполнить", async () => {
    const response = await inject({ method: "GET", url: "/health/live" });
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none';frame-ancestors 'none';base-uri 'none';form-action 'none'",
    );
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains",
    );
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("ID запроса (OBS-01)", () => {
  it("создаётся и возвращается клиенту", async () => {
    const response = await inject({ method: "GET", url: "/health/live" });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("берётся от балансировщика, если безопасен", async () => {
    const response = await inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "lb-7f3a9c2e-0001" },
    });
    expect(response.headers["x-request-id"]).toBe("lb-7f3a9c2e-0001");
  });

  it("опасный ID заменяется: в лог не попадёт чужой текст", async () => {
    const response = await inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": 'evil" level=fatal msg=взлом' },
    });
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ошибки в формате problem+json (RFC 9457)", () => {
  it("неизвестный адрес → 404", async () => {
    const response = await inject({ method: "GET", url: "/api/v1/nothing-here" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toBe("application/problem+json; charset=utf-8");
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Не найдено",
      status: 404,
      requestId: response.headers["x-request-id"],
    });
  });

  it("внутренняя ошибка → 500 без подробностей; подробности — только в логе", async () => {
    const response = await inject({ method: "GET", url: "/api/v1/test/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("s3cr3t-value");
    expect(response.json()).toEqual({
      type: "about:blank",
      title: "Внутренняя ошибка",
      status: 500,
      requestId: response.headers["x-request-id"],
    });
    const entry = app()
      .logs()
      .find(
        (line) => line.requestId === response.headers["x-request-id"] && line.level === "error",
      );
    expect(entry).toMatchObject({ msg: "необработанная ошибка" });
  });

  it("ошибка с пояснением для человека → detail", async () => {
    const response = await inject({ method: "GET", url: "/api/v1/test/conflict" });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ title: "Конфликт", detail: "Поддомен уже занят" });
  });

  it("неверный JSON → 400", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      headers: { "content-type": "application/json" },
      payload: "{не json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ title: "Некорректный запрос", status: 400 });
  });

  it("тело больше 1 МБ → 413", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ title: "x".repeat(1024 * 1024), amount: 1 }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ title: "Слишком большой запрос" });
  });
});

describe("проверка данных по схеме", () => {
  it("корректное тело проходит", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      payload: { title: "Макет ЖК", amount: 380_000 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ title: "Макет ЖК", amount: 380_000 });
  });

  it("ошибки — по полям, по-русски и без введённых значений", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      payload: { title: "", amount: -5, extra: "секретное значение" },
    });
    expect(response.statusCode).toBe(400);
    const problem = response.json<{ errors: { path: string; message: string }[] }>();
    expect(problem).toMatchObject({
      title: "Некорректный запрос",
      detail: "Проверьте поля запроса",
    });
    expect(problem.errors.map((error) => error.path).sort()).toEqual(["amount", "title"]);
    expect(problem.errors.every((error) => /[а-яё]/i.test(error.message))).toBe(true);
    expect(response.body).not.toContain("секретное значение");
  });
});

describe("защита от CSRF (SEC-10)", () => {
  it("изменяющий запрос с чужого сайта отклоняется", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      payload: { title: "Макет", amount: 1 },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ title: "Доступ запрещён" });
  });

  it("старый браузер без Sec-Fetch-Site: чужой Origin отклоняется", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      headers: { origin: "https://evil.example" },
      payload: { title: "Макет", amount: 1 },
    });
    expect(response.statusCode).toBe(403);
  });

  it("запрос со своей страницы проходит", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals",
      headers: { "sec-fetch-site": "same-origin" },
      payload: { title: "Макет", amount: 1 },
    });
    expect(response.statusCode).toBe(201);
  });
});

describe("проверки здоровья", () => {
  it("живость и готовность — без входа и без префикса /api", async () => {
    expect((await inject({ method: "GET", url: "/health/live" })).json()).toEqual({ status: "ok" });
    expect((await inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });

  it("без связи с БД экземпляр не готов: 503, причина — только в логе", async () => {
    dbUp = false;
    try {
      const response = await inject({ method: "GET", url: "/health/ready" });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("нет связи");
    } finally {
      dbUp = true;
    }
  });
});

describe("лог запросов (OBS-01)", () => {
  it("строка на запрос: маршрут без query-строки, без cookie и заголовков", async () => {
    const response = await inject({
      method: "POST",
      url: "/api/v1/test/deals?email=client@example.test",
      headers: { cookie: "session=s3cr3t-value", authorization: "Bearer s3cr3t-value" },
      payload: { title: "Макет", amount: 1 },
    });
    const entries = app()
      .logs()
      .filter((line) => line.requestId === response.headers["x-request-id"]);
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        msg: "запрос",
        method: "POST",
        route: "/api/v1/test/deals",
        status: 201,
      }),
    ]);
    const raw = JSON.stringify(entries);
    expect(raw).not.toContain("s3cr3t-value");
    expect(raw).not.toContain("client@example.test");
  });

  it("проверки здоровья не засоряют лог", async () => {
    const response = await inject({ method: "GET", url: "/health/live" });
    expect(
      app()
        .logs()
        .some((line) => line.requestId === response.headers["x-request-id"]),
    ).toBe(false);
  });
});
