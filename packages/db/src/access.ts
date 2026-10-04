import { sql } from "drizzle-orm";
import type { Database, Transaction } from "./client.js";

/** Область видимости сущности: свои / отдела / все (F-ROLE). */
export type Scope = "own" | "team" | "all";

/**
 * Профиль доступа пользователя в компании. Вычисляется один раз при входе и при изменении
 * прав, хранится в кэше (ADR-0002). Политики RLS читают его из настроек транзакции.
 */
export interface AccessContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly scopes: {
    readonly deals: { readonly read: Scope; readonly write: Scope };
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPES: readonly Scope[] = ["own", "team", "all"];

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new TypeError(`${field}: ожидался UUID`);
}

function assertScope(value: Scope, field: string): void {
  if (!SCOPES.includes(value)) throw new TypeError(`${field}: неизвестная область видимости`);
}

/**
 * Работа с данными пользователя вне компании — например, справочник его компаний (D30).
 * В контексте только пользователь: данные компаний без withAccess не видны.
 */
export async function withUser<T>(
  db: Database,
  userId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  assertUuid(userId, "userId");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return work(tx);
  });
}

/**
 * Выполняет работу в транзакции с контекстом доступа. Настройки выставляются через
 * set_config(…, true) — действуют только до конца транзакции и не «перетекают»
 * в чужие запросы при переиспользовании соединения из пула.
 */
export async function withAccess<T>(
  db: Database,
  context: AccessContext,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  assertUuid(context.tenantId, "tenantId");
  assertUuid(context.userId, "userId");
  context.teamIds.forEach((id) => {
    assertUuid(id, "teamIds");
  });
  assertScope(context.scopes.deals.read, "scopes.deals.read");
  assertScope(context.scopes.deals.write, "scopes.deals.write");

  return db.transaction(async (tx) => {
    await tx.execute(sql`select
      set_config('app.tenant_id', ${context.tenantId}, true),
      set_config('app.user_id', ${context.userId}, true),
      set_config('app.team_ids', ${context.teamIds.join(",")}, true),
      set_config('app.scope_deals_read', ${context.scopes.deals.read}, true),
      set_config('app.scope_deals_write', ${context.scopes.deals.write}, true)`);
    return work(tx);
  });
}
