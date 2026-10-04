import { hostname } from "node:os";
import type { LoggerService } from "@nestjs/common";
import { pino, stdTimeFunctions, type DestinationStream, type Level, type Logger } from "pino";
import type { Config } from "../config/config.js";

/**
 * Что не попадает в логи ни при каких условиях (OBS-01): учётные данные, токены, коды.
 * Запросы целиком мы не логируем — это страховка от случайного `log.info({ body })`.
 */
const REDACT = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.secret",
  "*.code",
  "*.backupCodes",
];

/** Структурированные логи в JSON — для сборщика логов в облаке (ADR-0003). */
export function createLogger(level: Config["LOG_LEVEL"], destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: "zvenko-api", host: hostname() },
      timestamp: stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: REDACT, censor: "[скрыто]" },
    },
    destination,
  );
}

/** Сообщения самого NestJS — в тот же логгер, в том же формате. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.write("info", message, params);
  }

  error(message: unknown, ...params: unknown[]): void {
    this.write("error", message, params);
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", message, params);
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", message, params);
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.write("trace", message, params);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    this.write("fatal", message, params);
  }

  /** NestJS передаёт контекст последним аргументом, а для ошибок — ещё и стек: error(message, stack, context). */
  private write(level: Level, message: unknown, params: unknown[]): void {
    const last = params.at(-1);
    const context = typeof last === "string" ? last : undefined;
    if (message instanceof Error) {
      this.logger[level]({ context, err: message }, message.message);
      return;
    }
    const stack =
      level === "error" && typeof params[0] === "string" && params.length > 1
        ? params[0]
        : undefined;
    this.logger[level]({ context, stack }, typeof message === "string" ? message : String(message));
  }
}
