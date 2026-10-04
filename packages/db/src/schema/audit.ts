import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  inet,
  jsonb,
  pgPolicy,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { appRole, tenantIsolation } from "./rls.js";
import { tenants } from "./tenancy.js";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * Журнал аудита компании (F-AUD, SEC-07). Записи только дописываются: у роли приложения
 * нет UPDATE и DELETE, а изменение и удаление запрещены триггером даже владельцу схемы.
 *
 * Записи компании связаны в цепочку хэшей: `hash` = SHA-256(`prev_hash` + содержимое записи).
 * Номер, время и хэши ставит триггер — приложение передаёт только содержимое и не может
 * задать их само (права на вставку — только в колонки содержимого). Правку или удаление
 * записи в обход триггера находит проверка цепочки (`verifyAuditLog`).
 */
export const auditLog = pgTable(
  "audit_log",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // Номер записи в цепочке компании: 1, 2, 3… без пропусков.
    seq: bigint("seq", { mode: "number" }).notNull(),
    // Время записи по часам БД (UTC), с точностью до миллисекунды.
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 }).notNull(),
    // Кто: пользователь, сотрудник поддержки, система или неизвестный (неудачный вход).
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    // Что сделано: `раздел.действие`, например `session.tenant_selected`.
    action: text("action").notNull(),
    result: text("result").notNull(),
    // Над каким объектом.
    objectType: text("object_type"),
    objectId: uuid("object_id"),
    // Откуда: IP и устройство (заголовок User-Agent), ID запроса — для поиска в логах.
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    // Подробности действия. Без секретов и без лишних ПДн.
    details: jsonb("details").notNull().default({}),
    // Версия формата хэша — чтобы формат можно было развивать, не ломая старые записи.
    hashVersion: smallint("hash_version").notNull(),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.seq] }),
    check(
      "audit_log_actor",
      sql`(${t.actorType} in ('user', 'support') and ${t.actorId} is not null)
        or (${t.actorType} in ('system', 'anonymous') and ${t.actorId} is null)`,
    ),
    check(
      "audit_log_action",
      sql`${t.action} ~ '^[a-z][a-z_]*(\\.[a-z][a-z_]*)+$' and char_length(${t.action}) <= 64`,
    ),
    check("audit_log_result", sql`${t.result} in ('success', 'failure')`),
    check(
      "audit_log_object",
      sql`(${t.objectType} is null) = (${t.objectId} is null)
        and (${t.objectType} is null or ${t.objectType} ~ '^[a-z][a-z_]{0,31}$')`,
    ),
    // Только адрес узла, без маски сети.
    check("audit_log_ip", sql`masklen(${t.ip}) = case family(${t.ip}) when 4 then 32 else 128 end`),
    check("audit_log_user_agent", sql`char_length(${t.userAgent}) <= 512`),
    check("audit_log_request_id", sql`${t.requestId} ~ '^[A-Za-z0-9-]{8,64}$'`),
    check(
      "audit_log_details",
      sql`jsonb_typeof(${t.details}) = 'object' and octet_length(${t.details}::text) <= 4096`,
    ),
    check("audit_log_hash", sql`octet_length(${t.prevHash}) = 32 and octet_length(${t.hash}) = 32`),
    tenantIsolation(t.tenantId),
    // Читать журнал можно в пределах компании; кто из сотрудников его видит — решают права
    // роли в приложении (F-AUD-03). Изменения и удаления нет ни в политиках, ни в правах.
    pgPolicy("audit_log_read", { for: "select", to: appRole, using: sql`true` }),
    pgPolicy("audit_log_insert", { for: "insert", to: appRole, withCheck: sql`true` }),
  ],
);

/** Служебная схема журнала: голова цепочки каждой компании и функции триггеров. */
export const audit = pgSchema("audit");

/**
 * Голова цепочки компании: номер, хэш и время последней записи. Триггер блокирует строку
 * до конца транзакции — записи одной компании встают в очередь, у разных компаний очереди
 * независимы. По голове проверка цепочки находит удаление последних записей.
 *
 * RLS включён, но не принудителен: триггер работает от владельца схемы и должен видеть
 * головы всех компаний. Роль приложения видит только голову своей компании.
 */
export const auditChainHeads = audit.table(
  "chain_heads",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    hash: bytea("hash").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    tenantIsolation(t.tenantId),
    pgPolicy("chain_heads_read", { for: "select", to: appRole, using: sql`true` }),
  ],
);
