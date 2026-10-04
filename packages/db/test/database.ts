import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { createDatabase, type Database } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";

// Тот же образ, что в compose.yaml; мажорная версия — как в Yandex Managed PostgreSQL (ADR-0003).
const IMAGE = "postgres:18.6-alpine3.24";

export interface TestDatabase {
  /** Владелец схемы (суперпользователь контейнера): миграции и подготовка данных. RLS не действует. */
  readonly owner: Database;
  readonly ownerPool: pg.Pool;
  /** Роль приложения: без BYPASSRLS, не владелец. Через неё проверяем изоляцию. */
  readonly app: Database;
  /** Адрес подключения ролью приложения — для API в интеграционных тестах. */
  readonly appUrl: string;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(IMAGE).start();
  const ownerPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });

  // Роль приложения создаёт инфраструктура — в тестах повторяем это вручную.
  const appPassword = randomBytes(18).toString("base64url");
  const client = await ownerPool.connect();
  try {
    await client.query(
      `create role zvenko_app login password ${client.escapeLiteral(appPassword)}
       nosuperuser nobypassrls nocreatedb nocreaterole`,
    );
  } finally {
    client.release();
  }

  const owner = createDatabase(ownerPool);
  await runMigrations(owner);

  const appUrl = new URL(container.getConnectionUri());
  appUrl.username = "zvenko_app";
  appUrl.password = appPassword;
  // Одно соединение: так тесты заодно проверяют, что контекст не «перетекает» между транзакциями.
  const appPool = new pg.Pool({ connectionString: appUrl.toString(), max: 1 });

  return {
    owner,
    ownerPool,
    app: createDatabase(appPool),
    appUrl: appUrl.toString(),
    async stop() {
      await appPool.end();
      await ownerPool.end();
      await container.stop();
    },
  };
}

/** Код ошибки PostgreSQL: Drizzle оборачивает исходную ошибку в cause. */
export function pgErrorCode(error: unknown): string | undefined {
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  const code = err.code ?? err.cause?.code;
  return typeof code === "string" ? code : undefined;
}
