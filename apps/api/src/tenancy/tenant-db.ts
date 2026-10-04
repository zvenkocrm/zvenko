import { Inject, Injectable } from "@nestjs/common";
import { type AccessContext, type Database, type Transaction, withAccess } from "@zvenko/db";
import { DATABASE } from "../database/database.module.js";

/** Пользователь «система» в контексте доступа: такого пользователя нет, своих данных у него нет. */
export const SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";

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
   * Транзакция компании от имени системы — для обработчиков событий (ADR-0005): видит данные
   * всей компании и только её. Пользователя в контексте нет.
   */
  asSystem<T>(tenantId: string, work: (tx: Transaction) => Promise<T>): Promise<T> {
    return withAccess(
      this.db,
      {
        tenantId,
        userId: SYSTEM_USER_ID,
        teamIds: [],
        scopes: { deals: { read: "all", write: "all" } },
      },
      work,
    );
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
