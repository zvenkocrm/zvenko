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

export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** В контейнере — 0.0.0.0; по умолчанию слушаем только локальный интерфейс. */
  HOST: z.string().trim().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  /** Подключение ролью приложения (без BYPASSRLS), не владельцем схемы. */
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  TRUST_PROXY: trustProxy.default(false),
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
