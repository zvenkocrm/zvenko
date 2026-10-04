import {
  boolean,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./tenancy.js";

/**
 * Схема модуля входа (ADR-0006): хэши паролей, сессии, одноразовые токены. Доступ —
 * только у роли zvenko_identity; роль приложения схему не видит, так что ошибка
 * в коде CRM не откроет пароли и сессии. Поля и их имена — те, что ждёт Better Auth.
 */
export const identity = pgSchema("identity");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/**
 * Сессия: простой — до 12 ч, абсолютный срок — 30 дней (D20, SEC-03). Активная компания
 * (F-AUTH-06) выбирается на сервере после проверки членства — клиент её не задаёт.
 */
export const sessions = identity.table(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    token: text("token").notNull().unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    activeTenantId: uuid("active_tenant_id"),
    ...timestamps,
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Способ входа пользователя. Пароль — хэш argon2id (SEC-01), провайдер `credential`.
 * Поля токенов внешних провайдеров обязательны в схеме Better Auth, но не используются:
 * вход через сторонние сервисы отключён.
 */
export const accounts = identity.table(
  "accounts",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("accounts_provider_account_idx").on(t.providerId, t.accountId),
    index("accounts_user_idx").on(t.userId),
  ],
);

/** Одноразовые токены: восстановление пароля, приглашения. Срок — в expiresAt. */
export const verifications = identity.table(
  "verifications",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier)],
);

/**
 * Второй фактор (SEC-02): секрет TOTP и резервные коды. Оба хранятся зашифрованными
 * ключом AUTH_SECRET (в продакшене — из хранилища секретов под KMS). Одна запись
 * на пользователя. После серии неверных кодов вход блокируется на время (lockedUntil).
 */
export const twoFactors = identity.table(
  "two_factors",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    // Поле только наше: Better Auth времени изменения у этой таблицы не ведёт.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("two_factors_user_idx").on(t.userId)],
);
