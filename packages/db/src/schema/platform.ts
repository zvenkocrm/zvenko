import { sql } from "drizzle-orm";
import { pgPolicy, pgSchema, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { appRole, currentUserId } from "./rls.js";
import { tenants, users } from "./tenancy.js";

/**
 * Схема платформы (ADR-0002): глобальные справочники без данных компаний и без ПДн.
 * Роль приложения только читает их; пишет модуль платформы.
 */
export const platform = pgSchema("platform");

/**
 * Справочник «поддомен → компания» для выбора компании по адресу сайта
 * (`neva.zvenko.ru` → Нева Макет). Только адресация: названий здесь нет — список клиентов
 * платформы не должен быть виден никому из компаний. Ведётся триггером на tenants.
 */
export const tenantDirectory = platform.table("tenant_directory", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  subdomain: text("subdomain").notNull().unique(),
  region: text("region").notNull(),
});

/**
 * Справочник «пользователь → компании»: в каких компаниях работает человек. Нужен там,
 * где компании ещё нет: события учётной записи пишутся в журналы всех его компаний (D30),
 * переключатель компаний (F-AUTH-06). Только ID, без ролей и ПДн. Ведётся триггером
 * на memberships.
 *
 * RLS включён, но не принудителен: триггер работает от владельца схемы. Роль приложения
 * видит только строки пользователя из контекста (`withUser`).
 */
export const membershipDirectory = platform.table(
  "membership_directory",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.tenantId] }),
    pgPolicy("membership_directory_own", {
      for: "select",
      to: appRole,
      using: sql`${t.userId} = ${currentUserId}`,
    }),
  ],
);
