import type { Type } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { configureApp, createAdapter } from "../src/app.js";
import { AppModule } from "../src/app.module.js";
import { loadConfig } from "../src/config/config.js";
import { createLogger, NestPinoLogger } from "../src/logging/logger.js";

export interface TestApp {
  readonly app: NestFastifyApplication;
  /** Строки лога, разобранные из JSON. */
  logs(): Record<string, unknown>[];
  close(): Promise<void>;
}

export interface TestAppOptions {
  /** По умолчанию — заведомо недоступная БД: пул подключается лениво, при первом запросе. */
  readonly databaseUrl?: string;
  readonly controllers?: Type[];
  readonly override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
}

/** Приложение с той же настройкой, что в продакшене (configureApp), и логом в память. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: options.databaseUrl ?? "postgres://zvenko_app:unused@127.0.0.1:9/zvenko",
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
  if (options.override) builder = options.override(builder);
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createAdapter(config, logger),
    {
      logger: new NestPinoLogger(logger),
    },
  );
  configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    logs: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    close: () => app.close(),
  };
}
