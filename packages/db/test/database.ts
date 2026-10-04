import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { expect } from "vitest";
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
  /** Роль модуля входа: схема identity и пользователи, без данных компаний. */
  readonly identity: Database;
  readonly identityUrl: string;
  stop(): Promise<void>;
}

/** Роли создаёт инфраструктура — в тестах повторяем это вручную, с теми же ограничениями. */
const ROLES = ["zvenko_app", "zvenko_identity"] as const;

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(IMAGE).start();
  const ownerPool = new pg.Pool({ connectionString: container.getConnectionUri(), max: 2 });

  const urls = new Map<string, string>();
  const client = await ownerPool.connect();
  try {
    for (const role of ROLES) {
      const password = randomBytes(18).toString("base64url");
      await client.query(
        `create role ${role} login password ${client.escapeLiteral(password)}
         nosuperuser nobypassrls nocreatedb nocreaterole`,
      );
      const url = new URL(container.getConnectionUri());
      url.username = role;
      url.password = password;
      urls.set(role, url.toString());
    }
  } finally {
    client.release();
  }

  const owner = createDatabase(ownerPool);
  await runMigrations(owner);

  const appUrl = urls.get("zvenko_app") ?? "";
  const identityUrl = urls.get("zvenko_identity") ?? "";
  // Одно соединение: так тесты заодно проверяют, что контекст не «перетекает» между транзакциями.
  const appPool = new pg.Pool({ connectionString: appUrl, max: 1 });
  const identityPool = new pg.Pool({ connectionString: identityUrl, max: 1 });

  return {
    owner,
    ownerPool,
    app: createDatabase(appPool),
    appUrl,
    identity: createDatabase(identityPool),
    identityUrl,
    async stop() {
      await appPool.end();
      await identityPool.end();
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

/** Ждёт, что работа завершится ошибкой PostgreSQL с этим кодом. */
export async function expectPgError(work: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await work.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, `ожидалась ошибка PostgreSQL ${code}`).toBeDefined();
  expect(pgErrorCode(error)).toBe(code);
}
