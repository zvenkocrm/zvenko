// Локальная среда одной командой (ADR-0008, MAINT-05):
// 1. Создаёт .env со случайными паролями, если его нет. Настоящих секретов прода здесь нет.
// 2. Создаёт конфиг ключей S3 для SeaweedFS.
// 3. Запускает сервисы Docker Compose и ждёт их готовности.
// 4. Ставит git-хуки (lefthook).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env";
const S3_CONFIG = ".dev/seaweedfs/s3.json";

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

function ensureEnv() {
  if (existsSync(ENV_FILE)) return parseEnv(readFileSync(ENV_FILE, "utf8"));
  const env = {
    POSTGRES_PASSWORD: secret(),
    VALKEY_PASSWORD: secret(),
    S3_ACCESS_KEY: secret(12),
    S3_SECRET_KEY: secret(),
  };
  const lines = [
    "# Локальные секреты для разработки. Создано scripts/dev-up.mjs. Не коммитить.",
    ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
  ];
  writeFileSync(ENV_FILE, lines.join("\n") + "\n", { mode: 0o600 });
  console.log("Создан .env со случайными паролями.");
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
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) return null;
  return result.status ?? 1;
}

const env = ensureEnv();
writeS3Config(env);

if (run("docker", ["compose", "up", "--detach", "--wait"]) !== 0) {
  console.error("Не удалось запустить сервисы. Запущен ли Docker?");
  process.exit(1);
}

const hooks = run("lefthook", ["install"]);
if (hooks === null) {
  console.warn("lefthook не найден — git-хуки не установлены. Выполните `mise install`.");
} else if (hooks !== 0) {
  console.warn("git-хуки не установлены: lefthook завершился с ошибкой (это git-репозиторий?).");
}

console.log(`
Локальная среда готова:
  PostgreSQL  127.0.0.1:5432  пользователь и база: zvenko
  Valkey      127.0.0.1:6379
  S3          http://127.0.0.1:8333
  Почта       http://127.0.0.1:8025
`);
