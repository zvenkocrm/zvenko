import {
  accounts,
  type Database,
  newId,
  sessions,
  twoFactors,
  users,
  verifications,
} from "@zvenko/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins/two-factor";
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

/** Резервных кодов 2FA — 10 одноразовых (F-AUTH-05). */
export const BACKUP_CODES = 10;

/**
 * Эндпоинты Better Auth, которые мы не используем, — выключены: меньше поверхность атаки.
 * Восстановление пароля включится вместе с отправкой писем, проверка пароля — с повторным
 * подтверждением опасных действий. Второй фактор — только приложение-аутентификатор
 * и резервные коды: коды по почте выключены.
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
  "/two-factor/send-otp",
  "/two-factor/verify-otp",
];

const hostOf = (origin: string): string => origin.replace(/^https?:\/\//, "");

/**
 * «Доверенное устройство» пропускает второй фактор до 30 дней. Нам нужен второй фактор
 * при каждом входе (SEC-02), поэтому такие запросы отклоняются — в том числе с сервера.
 */
const rejectTrustedDevices = createAuthMiddleware((ctx) => {
  const body: unknown = ctx.body;
  if (
    ctx.path.startsWith("/two-factor/verify") &&
    typeof body === "object" &&
    body !== null &&
    "trustDevice" in body &&
    body.trustDevice === true
  ) {
    throw new APIError("BAD_REQUEST", {
      code: "TRUSTED_DEVICES_DISABLED",
      message: "Доверенные устройства отключены: второй фактор нужен при каждом входе",
    });
  }
  return Promise.resolve();
});

/**
 * Better Auth за интерфейсом AuthPort (ADR-0006): включено только то, что нужно, —
 * вход по почте и паролю, второй фактор и сессии. Регистрации нет: пользователи
 * появляются по приглашению (D15).
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
      schema: {
        user: users,
        session: sessions,
        account: accounts,
        verification: verifications,
        twoFactor: twoFactors,
      },
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
    plugins: [
      // Второй фактор (SEC-02, F-AUTH-05): приложение-аутентификатор (TOTP) и резервные коды.
      // Секрет и коды хранятся зашифрованными ключом AUTH_SECRET.
      twoFactor({
        issuer: "Звенко",
        backupCodeOptions: { amount: BACKUP_CODES, length: 10, storeBackupCodes: "encrypted" },
        // Пять неверных кодов подряд — вход в аккаунт заблокирован на 15 минут.
        accountLockout: { enabled: true, maxFailedAttempts: 5, durationSeconds: 15 * 60 },
      }),
    ],
    hooks: { before: rejectTrustedDevices },
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
      // Защита от перебора пароля и кодов (SEC-04). Лимиты на аккаунт и капча — следующим шагом.
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
      },
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
