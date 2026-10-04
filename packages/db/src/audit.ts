import { createHash } from "node:crypto";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";
import { auditChainHeads, auditLog } from "./schema/audit.js";

/** Кто совершил действие (F-AUD-02). Неизвестный — например, неудачная попытка входа. */
export type AuditActor =
  | { readonly type: "user" | "support"; readonly id: string }
  | { readonly type: "system" | "anonymous" };

export type AuditResult = "success" | "failure";

export type AuditJson =
  string | number | boolean | null | readonly AuditJson[] | { readonly [key: string]: AuditJson };

/** Содержимое записи. Номер, время и хэши ставит БД — их нельзя передать. */
export interface AuditEntry {
  readonly tenantId: string;
  readonly actor: AuditActor;
  /** `раздел.действие`, например `session.tenant_selected`. */
  readonly action: string;
  readonly result: AuditResult;
  readonly object?: { readonly type: string; readonly id: string };
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  /** Подробности действия — без секретов и без лишних ПДн. */
  readonly details?: Readonly<Record<string, AuditJson>>;
}

export interface AppendedAuditEntry {
  readonly seq: number;
}

type Executor = Database | Transaction;

/**
 * Дописывает запись в журнал компании (SEC-07). Вызывать в транзакции с контекстом этой
 * компании (withAccess) — тогда запись и действие фиксируются вместе.
 *
 * Запись блокирует цепочку компании до конца транзакции: другие записи этой компании ждут.
 * Поэтому в транзакции действия её делают последним шагом.
 */
export async function appendAuditEntry(
  db: Executor,
  entry: AuditEntry,
): Promise<AppendedAuditEntry> {
  const actorId = "id" in entry.actor ? entry.actor.id : null;
  // Колонки перечислены явно: роли приложения разрешена вставка только содержимого записи.
  const result = await db.execute<{ seq: string }>(sql`
    insert into audit_log (tenant_id, actor_type, actor_id, action, result, object_type,
                           object_id, ip, user_agent, request_id, details)
    values (${entry.tenantId}, ${entry.actor.type}, ${actorId}, ${entry.action}, ${entry.result},
            ${entry.object?.type ?? null}, ${entry.object?.id ?? null}, ${entry.ip ?? null},
            ${entry.userAgent ?? null}, ${entry.requestId ?? null},
            ${JSON.stringify(entry.details ?? {})})
    returning seq`);
  const row = result.rows[0];
  if (!row) throw new Error("запись аудита не добавлена");
  return { seq: Number(row.seq) };
}

/** Хэш перед первой записью компании. */
const GENESIS = Buffer.alloc(32);
const NULL_FIELD = Buffer.from([0]);
const VALUE_FIELD = Buffer.from([1]);

/** Запись так, как её хэширует триггер `audit.append_entry`: поля — в текстовом виде БД. */
interface ChainRow {
  readonly hashVersion: number;
  readonly tenantId: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly result: string;
  readonly objectType: string | null;
  readonly objectId: string | null;
  /** Адрес без маски сети: host(ip). */
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  /** Текст jsonb, как его выводит PostgreSQL: details::text. */
  readonly details: string;
  readonly prevHash: Buffer;
  readonly hash: Buffer;
}

/**
 * Хэш записи, формат 1: SHA-256(хэш предыдущей записи + поля по порядку). Поле NULL — байт 00,
 * значение — байт 01, длина в байтах (uint32, big-endian) и текст в UTF-8.
 * Тот же расчёт делает триггер в БД (миграция 0009); проверка от него не зависит.
 */
function entryHash(row: ChainRow): Buffer {
  const hash = createHash("sha256").update(row.prevHash);
  const fields = [
    String(row.hashVersion),
    row.tenantId,
    String(row.seq),
    row.occurredAt.toISOString(),
    row.actorType,
    row.actorId,
    row.action,
    row.result,
    row.objectType,
    row.objectId,
    row.ip,
    row.userAgent,
    row.requestId,
    row.details,
  ];
  for (const value of fields) {
    if (value === null) {
      hash.update(NULL_FIELD);
      continue;
    }
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(VALUE_FIELD).update(length).update(bytes);
  }
  return hash.digest();
}

/**
 * Итог проверки цепочки. Проблемы:
 * - `sequence` — нет записи с номером `seq` (удалена из середины);
 * - `link` — запись `seq` ссылается не на хэш предыдущей (предыдущую подменили);
 * - `hash` — содержимое записи `seq` не совпадает с её хэшем (запись изменена);
 * - `head` — цепочка не доходит до головы или расходится с ней (удалены последние записи).
 */
export type AuditVerification =
  | { readonly ok: true; readonly entries: number }
  | {
      readonly ok: false;
      readonly seq: number;
      readonly problem: "sequence" | "link" | "hash" | "head";
    };

const BATCH_SIZE = 1000;

/**
 * Проверяет цепочку журнала компании: номера без пропусков, ссылки на предыдущие записи
 * и хэши содержимого. Подмену записи в обход триггера (владельцем схемы, из резервной
 * копии) видно по первой несовпавшей записи.
 *
 * Ограничение: тот, кто пересчитает всю цепочку и голову, подмену скроет. От этого защитит
 * копия голов цепочек во внешнем хранилище с блокировкой удаления — к запуску (T19).
 */
export async function verifyAuditLog(
  db: Executor,
  tenantId: string,
  batchSize: number = BATCH_SIZE,
): Promise<AuditVerification> {
  let expectedSeq = 1;
  let prevHash: Buffer = GENESIS;
  for (;;) {
    const rows = await db
      .select({
        hashVersion: auditLog.hashVersion,
        tenantId: auditLog.tenantId,
        seq: auditLog.seq,
        occurredAt: auditLog.occurredAt,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        action: auditLog.action,
        result: auditLog.result,
        objectType: auditLog.objectType,
        objectId: auditLog.objectId,
        ip: sql<string | null>`host(${auditLog.ip})`,
        userAgent: auditLog.userAgent,
        requestId: auditLog.requestId,
        details: sql<string>`${auditLog.details}::text`,
        prevHash: auditLog.prevHash,
        hash: auditLog.hash,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), gt(auditLog.seq, expectedSeq - 1)))
      .orderBy(asc(auditLog.seq))
      .limit(batchSize);

    for (const row of rows) {
      if (row.seq !== expectedSeq) return { ok: false, seq: expectedSeq, problem: "sequence" };
      if (!row.prevHash.equals(prevHash)) return { ok: false, seq: row.seq, problem: "link" };
      if (row.hashVersion !== 1 || !entryHash(row).equals(row.hash)) {
        return { ok: false, seq: row.seq, problem: "hash" };
      }
      prevHash = row.hash;
      expectedSeq++;
    }
    if (rows.length < batchSize) break;
  }

  const entries = expectedSeq - 1;
  const [head] = await db
    .select({ seq: auditChainHeads.seq, hash: auditChainHeads.hash })
    .from(auditChainHeads)
    .where(eq(auditChainHeads.tenantId, tenantId));
  const headSeq = head?.seq ?? 0;
  if (headSeq !== entries) {
    return { ok: false, seq: Math.min(headSeq, entries) + 1, problem: "head" };
  }
  if (!(head?.hash ?? GENESIS).equals(prevHash))
    return { ok: false, seq: entries, problem: "head" };
  return { ok: true, entries };
}
