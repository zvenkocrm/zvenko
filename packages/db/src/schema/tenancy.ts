import { sql } from "drizzle-orm";
import {
  foreignKey,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.js";
import { appRole, currentTenantId, tenantIsolation, tenantWideAccess } from "./rls.js";

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
 * (F-AUTH-06). Приложение видит только сотрудников текущей компании. Вход и учётные данные —
 * отдельная роль модуля identity (ADR-0006).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    email: text("email").notNull().unique(),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    pgPolicy("users_visible_in_tenant", {
      for: "select",
      to: appRole,
      using: sql`exists (select 1 from memberships m where m.user_id = ${t.id} and m.tenant_id = ${currentTenantId})`,
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
