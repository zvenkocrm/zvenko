import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.js";
import {
  appRole,
  currentTenantId,
  identityRole,
  tenantIsolation,
  tenantWideAccess,
} from "./rls.js";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Компания-арендатор. Создаёт её модуль платформы; приложение видит и меняет только свою. */
export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    name: text("name").notNull(),
    subdomain: text("subdomain").notNull().unique(),
    region: text("region").notNull().default("ru-central1"),
    createdAt: createdAt(),
  },
  (t) => [
    pgPolicy("tenant_isolation", {
      as: "restrictive",
      for: "all",
      to: appRole,
      using: sql`${t.id} = ${currentTenantId}`,
      withCheck: sql`${t.id} = ${currentTenantId}`,
    }),
    pgPolicy("tenants_read", { for: "select", to: appRole, using: sql`true` }),
    pgPolicy("tenants_update", {
      for: "update",
      to: appRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/**
 * Пользователь — глобальная учётная запись: один человек может работать в нескольких компаниях
 * (F-AUTH-06). Приложение видит только сотрудников текущей компании. Создаёт и меняет
 * пользователей модуль входа своей ролью (ADR-0006); поля — те, что ждёт Better Auth.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    // Почта подтверждена: пользователи появляются по приглашению — ссылка из письма и есть проверка.
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    // Включена ли 2FA (SEC-02). Обязательна для владельца и администраторов компании.
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Одна почта — один пользователь независимо от регистра букв.
    check("users_email_lowercase", sql`${t.email} = lower(${t.email})`),
    pgPolicy("users_visible_in_tenant", {
      for: "select",
      to: appRole,
      using: sql`exists (select 1 from memberships m where m.user_id = ${t.id} and m.tenant_id = ${currentTenantId})`,
    }),
    pgPolicy("users_identity", {
      for: "all",
      to: identityRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/** Отдел компании (F-USR-04). */
export const teams = pgTable(
  "teams",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: uuid("id").notNull().$defaultFn(newId),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    tenantIsolation(t.tenantId),
    tenantWideAccess("teams"),
  ],
);

/**
 * Сотрудник компании: пользователь + роль + отдел. Составной внешний ключ на отдел
 * (tenant_id, team_id) не даёт сослаться на отдел чужой компании.
 */
export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    teamId: uuid("team_id"),
    role: text("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    foreignKey({
      name: "memberships_team_fk",
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    tenantIsolation(t.tenantId),
    tenantWideAccess("memberships"),
  ],
);
