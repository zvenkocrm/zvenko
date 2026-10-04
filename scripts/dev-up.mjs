// Локальная среда одной командой (ADR-0008, MAINT-05):
// 1. Создаёт .env со случайными паролями или дописывает в него недостающие переменные.
//    Настоящих секретов прода здесь нет.
// 2. Создаёт конфиг ключей S3 для SeaweedFS.
// 3. Запускает сервисы Docker Compose и ждёт их готовности.
// 4. Создаёт в PostgreSQL роли приложения и модуля входа — как в проде, без прав суперпользователя и BYPASSRLS.
// 5. Ставит git-хуки (lefthook).
// Миграции применяет следующий шаг `pnpm dev:up` — `pnpm --filter @zvenko/db db:migrate`.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env";
const S3_CONFIG = ".dev/seaweedfs/s3.json";
const ENV_HEADER =
  "# Локальные секреты для разработки. Создано scripts/dev-up.mjs. Не коммитить.\n";

const secret = (bytes = 24) => randomBytes(bytes).toString("base64url");

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
}

/** Содержимое .env или null, если файла нет. Без отдельной проверки — она устарела бы к записи. */
function readEnvFile() {
  try {
    return readFileSync(ENV_FILE, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Значения, которых нет в .env, создаются; существующие не меняются. */
function ensureEnv() {
  const text = readEnvFile();
  const env = parseEnv(text ?? "");
  const generators = {
    POSTGRES_PASSWORD: () => secret(),
    VALKEY_PASSWORD: () => secret(),
    S3_ACCESS_KEY: () => secret(12),
    S3_SECRET_KEY: () => secret(),
    APP_DB_PASSWORD: () => secret(),
    IDENTITY_DB_PASSWORD: () => secret(),
    // API подключается ролью приложения (RLS действует), миграции — ролью-владельцем схемы.
    DATABASE_URL: () => `postgres://zvenko_app:${env.APP_DB_PASSWORD}@127.0.0.1:5432/zvenko`,
    MIGRATION_DATABASE_URL: () =>
      `postgres://zvenko:${env.POSTGRES_PASSWORD}@127.0.0.1:5432/zvenko`,
    // Модуль входа — своей ролью: пароли и сессии отдельно от данных компаний (ADR-0006).
    IDENTITY_DATABASE_URL: () =>
      `postgres://zvenko_identity:${env.IDENTITY_DB_PASSWORD}@127.0.0.1:5432/zvenko`,
    AUTH_SECRET: () => secret(48),
    AUTH_ORIGINS: () => "http://127.0.0.1:3000,http://localhost:3000",
  };
  const added = [];
  for (const [key, generate] of Object.entries(generators)) {
    if (!env[key]) {
      env[key] = generate();
      added.push(key);
    }
  }
  if (added.length > 0) {
    const lines = `${added.map((key) => `${key}=${env[key]}`).join("\n")}\n`;
    if (text === null) {
      // Флаг wx: файл не перезапишется, если его успели создать параллельно.
      writeFileSync(ENV_FILE, ENV_HEADER + lines, { mode: 0o600, flag: "wx" });
    } else {
      // Только дописываем в конец: существующие строки не трогаем.
      appendFileSync(ENV_FILE, (text.endsWith("\n") ? "" : "\n") + lines, { mode: 0o600 });
    }
    console.log(`В .env добавлено: ${added.join(", ")}.`);
  }
  return env;
}

function writeS3Config(env) {
  mkdirSync(".dev/seaweedfs", { recursive: true });
  const config = {
    identities: [
      {
        name: "zvenko",
        credentials: [{ accessKey: env.S3_ACCESS_KEY, secretKey: env.S3_SECRET_KEY }], // gitleaks:allow — ссылки на переменные, не секреты
        actions: ["Admin", "Read", "Write", "List", "Tagging"],
      },
    ],
  };
  writeFileSync(S3_CONFIG, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

// Без shell: аргументы передаются как есть, без склейки строк (DEP0190).
// docker и lefthook — исполняемые файлы и на Windows запускаются напрямую.
function run(command, args, input) {
  const result = spawnSync(command, args, {
    stdio: [input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
    input,
  });
  if (result.error) return null;
  return result.status ?? 1;
}

/**
 * Роли приложения и модуля входа: создаются один раз, пароли — из .env. Без прав
 * суперпользователя и обхода RLS. В проде роли создаёт инфраструктура.
 */
function ensureRoles(env) {
  const roles = { zvenko_app: env.APP_DB_PASSWORD, zvenko_identity: env.IDENTITY_DB_PASSWORD };
  const sql = Object.entries(roles)
    .map(
      ([role, password]) => `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
ALTER ROLE ${role} WITH LOGIN PASSWORD '${password.replaceAll("'", "''")}';
`,
    )
    .join("");
  // SQL с паролями — через stdin, а не аргументом: аргументы видны в списке процессов.
  const psql = ["compose", "exec", "-T", "postgres", "psql", "-q", "-v", "ON_ERROR_STOP=1"];
  return run("docker", [...psql, "-U", "zvenko", "-d", "zvenko"], sql);
}

const env = ensureEnv();
writeS3Config(env);

if (run("docker", ["compose", "up", "--detach", "--wait"]) !== 0) {
  console.error("Не удалось запустить сервисы. Запущен ли Docker?");
  process.exit(1);
}

if (ensureRoles(env) !== 0) {
  console.error("Не удалось создать роли в PostgreSQL.");
  process.exit(1);
}

const hooks = run("lefthook", ["install"]);
if (hooks === null) {
  console.warn("lefthook не найден — git-хуки не установлены. Выполните `mise install`.");
} else if (hooks !== 0) {
  console.warn("git-хуки не установлены: lefthook завершился с ошибкой (это git-репозиторий?).");
}

console.log(`
Локальные сервисы готовы:
  PostgreSQL  127.0.0.1:5432  база zvenko; владелец — zvenko, приложение — zvenko_app, вход — zvenko_identity
  Valkey      127.0.0.1:6379
  S3          http://127.0.0.1:8333
  Почта       http://127.0.0.1:8025
`);
