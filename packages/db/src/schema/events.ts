import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { newId } from "../ids.js";
import { appRole, tenantIsolation, workerRole } from "./rls.js";
import { tenants } from "./tenancy.js";

/**
 * События до доставки подписчикам — transactional outbox (ADR-0005, F-EVT-01). Событие
 * пишется в той же транзакции, что и изменение данных: не теряется и не появляется
 * из откатившейся транзакции. Диспетчер — роль фоновых задач — переносит события
 * в очередь pg-boss и удаляет их отсюда.
 *
 * Роль приложения только дописывает события своей компании: читать, менять и удалять
 * их она не может.
 */
export const outbox = pgTable(
  "outbox",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // UUIDv7: упорядочен по времени — диспетчер переносит события по порядку.
    id: uuid("id").notNull().$defaultFn(newId),
    // `сущность.событие`, например `deal.stage_changed`.
    type: text("type").notNull(),
    objectType: text("object_type").notNull(),
    objectId: uuid("object_id").notNull(),
    // Автор изменения: пользователь, система или поддержка.
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    // Подробности: изменённые поля и значения, нужные подписчикам.
    data: jsonb("data").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.id] }),
    index("outbox_dispatch_order").on(t.id),
    check(
      "outbox_type",
      sql`${t.type} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$' and char_length(${t.type}) <= 64`,
    ),
    check("outbox_object_type", sql`${t.objectType} ~ '^[a-z][a-z_]{0,31}$'`),
    check(
      "outbox_actor",
      sql`(${t.actorType} in ('user', 'support') and ${t.actorId} is not null)
        or (${t.actorType} = 'system' and ${t.actorId} is null)`,
    ),
    check(
      "outbox_data",
      sql`jsonb_typeof(${t.data}) = 'object' and octet_length(${t.data}::text) <= 16384`,
    ),
    tenantIsolation(t.tenantId),
    pgPolicy("outbox_insert", { for: "insert", to: appRole, withCheck: sql`true` }),
    // Диспетчер видит события всех компаний: переносит их в очередь и удаляет.
    pgPolicy("outbox_dispatch", {
      for: "all",
      to: workerRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/**
 * Обработанные события — по подписчикам. Доставка «хотя бы один раз» может повторить
 * событие; отметка в той же транзакции, что и действие обработчика, не даёт повторить
 * действие (REL-05).
 */
export const eventReceipts = pgTable(
  "event_receipts",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    subscriber: text("subscriber").notNull(),
    eventId: uuid("event_id").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.subscriber, t.eventId] }),
    check("event_receipts_subscriber", sql`${t.subscriber} ~ '^[a-z][a-z0-9_.-]{0,63}$'`),
    tenantIsolation(t.tenantId),
    pgPolicy("event_receipts_read", { for: "select", to: appRole, using: sql`true` }),
    pgPolicy("event_receipts_insert", { for: "insert", to: appRole, withCheck: sql`true` }),
  ],
);
