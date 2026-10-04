import { randomBytes } from "node:crypto";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { expect } from "vitest";
import { createDatabase, type Database } from "../src/client.js";
import { runMigrations } from "../src/migrate.js";

// Тот же образ, что в compose.yaml; мажорная версия — как в Yandex Managed PostgreSQL (ADR-0003).
const IMAGE = "postgres:18.6-alpine3.24";
const DATABASE = "zvenko";

export interface TestDatabase {
  /**
   * Администратор БД — суперпользователь контейнера: подготовка данных и проверки в обход RLS.
   * У приложения в продакшене такой роли нет.
   */
  readonly admin: Database;
  readonly adminPool: pg.Pool;
  /**
   * Владелец схемы, как в Yandex Managed PostgreSQL: без суперпользователя и обхода RLS.
   * Он применяет миграции, поэтому функции SECURITY DEFINER и права по умолчанию работают
   * в тестах так же, как в продакшене.
   */
  readonly owner: Database;
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
const ROLES = ["zvenko_owner", "zvenko_app", "zvenko_identity"] as const;

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(IMAGE).start();
  const databaseUrl = (credentials?: { user: string; password: string }): string => {
    const url = new URL(container.getConnectionUri());
    url.pathname = `/${DATABASE}`;
    if (credentials) {
      url.username = credentials.user;
      url.password = credentials.password;
    }
    return url.toString();
  };

  // Роли и базу создаёт суперпользователь — так их создаёт инфраструктура в облаке.
  const urls = new Map<string, string>();
  const setup = new pg.Client({ connectionString: container.getConnectionUri() });
  await setup.connect();
  try {
    for (const role of ROLES) {
      const password = randomBytes(18).toString("base64url");
      await setup.query(
        `create role ${role} login password ${setup.escapeLiteral(password)}
         nosuperuser nobypassrls nocreatedb nocreaterole`,
      );
      urls.set(role, databaseUrl({ user: role, password }));
    }
    // База принадлежит владельцу схемы: он создаёт схемы и таблицы. Схема public
    // в PostgreSQL 15+ принадлежит владельцу базы.
    await setup.query(`create database ${DATABASE} owner zvenko_owner`);
  } finally {
    await setup.end();
  }

  const adminPool = new pg.Pool({ connectionString: databaseUrl(), max: 2 });
  const ownerPool = new pg.Pool({ connectionString: urls.get("zvenko_owner"), max: 1 });
  const owner = createDatabase(ownerPool);
  await runMigrations(owner);

  const appUrl = urls.get("zvenko_app") ?? "";
  const identityUrl = urls.get("zvenko_identity") ?? "";
  // Одно соединение: так тесты заодно проверяют, что контекст не «перетекает» между транзакциями.
  const appPool = new pg.Pool({ connectionString: appUrl, max: 1 });
  const identityPool = new pg.Pool({ connectionString: identityUrl, max: 1 });

  return {
    admin: createDatabase(adminPool),
    adminPool,
    owner,
    app: createDatabase(appPool),
    appUrl,
    identity: createDatabase(identityPool),
    identityUrl,
    async stop() {
      await appPool.end();
      await identityPool.end();
      await ownerPool.end();
      await adminPool.end();
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
