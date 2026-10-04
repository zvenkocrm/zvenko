import {
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.js";
import { scopedAccess, tenantIsolation } from "./rls.js";
import { memberships, teams, tenants } from "./tenancy.js";

/**
 * Сделка. Здесь — минимум полей, нужный фундаменту: проверка изоляции компаний и областей
 * видимости. Остальные поля добавит модуль CRM (P1).
 */
export const deals = pgTable(
  "deals",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: uuid("id").notNull().$defaultFn(newId),
    title: text("title").notNull(),
    ownerId: uuid("owner_id").notNull(),
    teamId: uuid("team_id"),
    amount: numeric("amount", { precision: 14, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    // Ответственный — сотрудник этой же компании, отдел — отдел этой же компании.
    foreignKey({
      name: "deals_owner_fk",
      columns: [t.tenantId, t.ownerId],
      foreignColumns: [memberships.tenantId, memberships.userId],
    }),
    foreignKey({
      name: "deals_team_fk",
      columns: [t.tenantId, t.teamId],
      foreignColumns: [teams.tenantId, teams.id],
    }),
    // Индексы под условия областей видимости (ADR-0002, PERF-06).
    index("deals_owner_idx").on(t.tenantId, t.ownerId),
    index("deals_team_idx").on(t.tenantId, t.teamId),
    tenantIsolation(t.tenantId),
    ...scopedAccess("deals", t.ownerId, t.teamId),
  ],
);
