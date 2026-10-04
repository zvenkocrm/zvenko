import { randomBytes } from "node:crypto";
import type { Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import type { FastifyRequest } from "fastify";
import { configureApp, createAdapter } from "../src/app.js";
import { AppModule } from "../src/app.module.js";
import { loadConfig } from "../src/config/config.js";
import { AuthPort, type Session } from "../src/identity/auth.port.js";
import { createLogger, NestPinoLogger } from "../src/logging/logger.js";

export interface Route {
  readonly method: string;
  readonly url: string;
}

export interface TestApp {
  readonly app: NestFastifyApplication;
  /** Все адреса, которые зарегистрировало приложение. */
  readonly routes: readonly Route[];
  /** Строки лога, разобранные из JSON. */
  logs(): Record<string, unknown>[];
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** По умолчанию — заведомо недоступная БД: пул подключается лениво, при первом запросе. */
  readonly databaseUrl?: string;
  /** Подключение ролью модуля входа; по умолчанию тоже недоступная БД. */
  readonly identityUrl?: string;
  readonly controllers?: Type[];
  /** Вход по тестовому заголовку вместо модуля identity — см. HeaderAuth. */
  readonly headerAuth?: boolean;
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

const SESSION_HEADER = "x-test-session";

/**
 * Тестовый вход: сессия берётся из заголовка `x-test-session: <userId>:<tenantId>`.
 * Существует только в тестах — в приложении такого адаптера нет.
 */
class HeaderAuth extends AuthPort {
  getSession(request: FastifyRequest): Promise<Session | null> {
    const value = request.headers[SESSION_HEADER];
    if (typeof value !== "string") return Promise.resolve(null);
    const [userId = "", tenantId = ""] = value.split(":");
    return Promise.resolve({
      sessionId: `test-${userId}`,
      userId,
      tenantId: tenantId === "" ? null : tenantId,
    });
  }
}

/** Заголовки запроса от имени сотрудника компании. */
export const as = (userId: string, tenantId: string | null): Record<string, string> => ({
  [SESSION_HEADER]: `${userId}:${tenantId ?? ""}`,
});

/** Адрес приложения в тестах: с ним совпадают Host и Origin запросов ко входу. */
export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_HOST = "localhost:3000";

/** Приложение с той же настройкой, что в продакшене (configureApp), и логом в память. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const unreachable = "postgres://zvenko:unused@127.0.0.1:9/zvenko";
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: options.databaseUrl ?? unreachable,
    IDENTITY_DATABASE_URL: options.identityUrl ?? unreachable,
    AUTH_SECRET: randomBytes(32).toString("base64url"),
    // localhost:80 — хост запросов inject по умолчанию.
    AUTH_ORIGINS: `${TEST_ORIGIN},http://localhost:80`,
  });
  const lines: string[] = [];
  const logger = createLogger(config.LOG_LEVEL, {
    write: (line: string) => {
      lines.push(line);
    },
  });

  let builder = Test.createTestingModule({
    imports: [AppModule.register(config, logger)],
    controllers: options.controllers ?? [],
  });
  if (options.headerAuth === true)
    builder = builder.overrideProvider(AuthPort).useClass(HeaderAuth);
  if (options.override) builder = options.override(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAdapter(config, logger),
    { logger: new NestPinoLogger(logger) },
  );
  configureApp(app, config);

  // Адреса регистрируются при init() — собираем их для реестра тестов изоляции.
  const routes: Route[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (method !== "HEAD") routes.push({ method, url: route.url });
      }
    });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    routes,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}
