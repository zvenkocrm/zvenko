import { isIP } from "node:net";
import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/**
 * Каким прокси верить в заголовках X-Forwarded-*: от них зависят IP клиента (лимиты, аудит)
 * и схема запроса. `false` — никаким; число — сколько прокси перед приложением;
 * список — адреса или подсети балансировщика через запятую.
 */
const trustProxy = z
  .string()
  .trim()
  .transform((value, ctx): boolean | number | string[] => {
    if (value === "false") return false;
    if (/^\d{1,2}$/.test(value)) return Number(value);
    const entries = value.split(",").map((entry) => entry.trim());
    const valid = entries.every((entry) => {
      const [address = "", prefix, extra] = entry.split("/");
      if (extra !== undefined || isIP(address) === 0) return false;
      if (prefix === undefined) return true;
      const bits = Number(prefix);
      return /^\d{1,3}$/.test(prefix) && bits <= (isIP(address) === 4 ? 32 : 128);
    });
    if (!valid) {
      ctx.addIssue({
        code: "custom",
        message: "ожидается false, число прокси или список IP/подсетей",
      });
      return z.NEVER;
    }
    return entries;
  });

/** Адрес сайта: схема и хост, без пути. `*.` в начале хоста — любой поддомен (адреса компаний). */
const ORIGIN = /^https?:\/\/(\*\.)?[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * Адреса, с которых открывают приложение: им разрешён вход и они попадают в доверенные
 * источники (CSRF). Через запятую, например `https://*.zvenko.ru`.
 */
const origins = z
  .string()
  .transform((value) => value.split(",").map((origin) => origin.trim().replace(/\/$/, "")))
  .pipe(z.array(z.string().regex(ORIGIN, "ожидается адрес вида https://app.zvenko.ru")).min(1));

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

export const configSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** В контейнере — 0.0.0.0; по умолчанию слушаем только локальный интерфейс. */
    HOST: z.string().trim().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
    /** Подключение ролью приложения (без BYPASSRLS), не владельцем схемы. */
    DATABASE_URL: postgresUrl,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /** Подключение ролью модуля входа: схема identity, без данных компаний (ADR-0006). */
    IDENTITY_DATABASE_URL: postgresUrl,
    /** Подключение ролью фоновых задач: outbox и очередь pg-boss, без данных компаний (ADR-0005). */
    WORKER_DATABASE_URL: postgresUrl,
    /**
     * Запускать ли в этом процессе фоновые задачи: перенос событий в очередь и их обработку.
     * На пилоте API и фоновые задачи работают одним процессом; позже — отдельными.
     */
    EVENTS_WORKER: z.enum(["on", "off"]).default("on"),
    /** Секрет подписи cookie и шифрования модуля входа. В продакшене — из хранилища секретов. */
    AUTH_SECRET: z.string().min(32, "не короче 32 символов"),
    AUTH_ORIGINS: origins,
    TRUST_PROXY: trustProxy.default(false),
  })
  .superRefine((config, ctx) => {
    // В продакшене cookie сессии уходят только по HTTPS.
    if (
      config.NODE_ENV === "production" &&
      config.AUTH_ORIGINS.some((o) => o.startsWith("http:"))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["AUTH_ORIGINS"],
        message: "в продакшене — только https",
      });
    }
  });

export type Config = Readonly<z.output<typeof configSchema>>;

/**
 * Читает и проверяет конфигурацию при старте: с ошибкой в настройках приложение не запускается.
 * В сообщении — только имена переменных: значения могут быть секретами.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
    );
    throw new Error(`Некорректная конфигурация:\n${problems.join("\n")}`);
  }
  return Object.freeze(result.data);
}
