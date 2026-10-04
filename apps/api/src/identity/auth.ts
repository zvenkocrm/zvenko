import { accounts, type Database, newId, sessions, users, verifications } from "@zvenko/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Logger } from "pino";
import type { Config } from "../config/config.js";
import {
  hashPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  verifyPassword,
} from "./password.js";

/**
 * Заголовок с IP клиента для Better Auth (лимиты, список сессий). Значение ставит сервер
 * из request.ip — с учётом TRUST_PROXY; заголовок от клиента отбрасывается (см. web-request.ts).
 */
export const CLIENT_IP_HEADER = "x-zvenko-client-ip";

/** Простой сессии — 12 ч, абсолютный срок — 30 дней (D20, SEC-03). */
export const SESSION_IDLE_SECONDS = 12 * 60 * 60;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Эндпоинты Better Auth, которые мы не используем, — выключены: меньше поверхность атаки.
 * Восстановление пароля включится вместе с отправкой писем, проверка пароля — с повторным
 * подтверждением опасных действий.
 */
const DISABLED_PATHS = [
  "/sign-up/email",
  "/sign-in/social",
  "/callback/:id",
  "/link-social",
  "/unlink-account",
  "/list-accounts",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/change-email",
  "/update-user",
  "/update-session",
  "/delete-user",
  "/delete-user/callback",
  "/request-password-reset",
  "/reset-password",
  "/reset-password/:token",
  "/send-verification-email",
  "/verify-email",
  "/verify-password",
  "/error",
];

const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, "");

/**
 * Better Auth за интерфейсом AuthPort (ADR-0006): включено только то, что нужно, —
 * вход по почте и паролю и сессии. Регистрации нет: пользователи появляются по приглашению (D15).
 */
export function createAuth(db: Database, config: Config, logger: Logger) {
  const secure = config.NODE_ENV === "production";
  return betterAuth({
    appName: "Звенко",
    secret: config.AUTH_SECRET,
    basePath: "/api/auth",
    // Адреса компаний — поддомены: хост запроса должен быть в списке разрешённых.
    baseURL: {
      allowedHosts: config.AUTH_ORIGINS.map(hostOf),
      protocol: secure ? "https" : "http",
    },
    trustedOrigins: [...config.AUTH_ORIGINS],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user: users, session: sessions, account: accounts, verification: verifications },
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
      password: { hash: hashPassword, verify: verifyPassword },
    },
    session: {
      expiresIn: SESSION_IDLE_SECONDS,
      // Срок продлевается при активности, но запись в БД — не чаще раза в час.
      updateAge: 60 * 60,
      freshAge: 15 * 60,
      // Кэш сессии в cookie выключен: отключение сотрудника и выход действуют сразу.
      cookieCache: { enabled: false },
      additionalFields: {
        // Активную компанию ставит сервер после проверки членства, клиент её не задаёт.
        activeTenantId: { type: "string", required: false, input: false },
      },
    },
    account: { accountLinking: { enabled: false } },
    advanced: {
      cookiePrefix: "zv",
      useSecureCookies: secure,
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => newId() },
    },
    rateLimit: {
      enabled: true,
      storage: "memory",
      window: 60,
      max: 100,
      // Защита от перебора пароля (SEC-04). Лимиты на аккаунт и капча — следующим шагом.
      customRules: { "/sign-in/email": { window: 60, max: 5 } },
    },
    disabledPaths: DISABLED_PATHS,
    telemetry: { enabled: false },
    // Только текст сообщения: в аргументах Better Auth могут быть данные пользователя.
    logger: {
      level: "warn",
      log: (level, message) => {
        logger[level]({ module: "better-auth" }, message);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
