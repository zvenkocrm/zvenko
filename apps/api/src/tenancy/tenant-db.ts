import { Inject, Injectable } from "@nestjs/common";
import { type AccessContext, type Database, type Transaction, withAccess } from "@zvenko/db";
import { DATABASE } from "../database/database.module.js";

/**
 * Единственный путь к данным компании: транзакция с профилем доступа. Политики RLS видят
 * компанию и области видимости пользователя (ADR-0002). Без профиля данных не видно вовсе.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  transaction<T>(access: AccessContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withAccess(this.db, access, work);
  }

  /**
   * Служебная транзакция компании без прав на её данные: область «свои» у пользователя,
   * от имени которого запись, — например, событие его учётной записи для журнала аудита.
   */
  forUser<T>(tenantId: string, userId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withAccess(
      this.db,
      { tenantId, userId, teamIds: [], scopes: { deals: { read: "own", write: "own" } } },
      work,
    );
  }
}
