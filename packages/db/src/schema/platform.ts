import { pgSchema, text, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenancy.js";

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
