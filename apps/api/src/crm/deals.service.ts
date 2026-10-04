import { Injectable } from "@nestjs/common";
import { type AccessContext, and, deals, desc, eq } from "@zvenko/db";

import { TenantDb } from "../tenancy/tenant-db.js";

export interface DealView {
  readonly id: string;
  readonly title: string;
  readonly ownerId: string;
  readonly teamId: string | null;
  /** Сумма — строкой: в numeric нет потерь точности, как у чисел JavaScript. */
  readonly amount: string | null;
}

const view = {
  id: deals.id,
  title: deals.title,
  ownerId: deals.ownerId,
  teamId: deals.teamId,
  amount: deals.amount,
};

/** До пагинации (P1) список ограничен последними сделками. */
const LIST_LIMIT = 100;

/**
 * Сделки. Компания — и в условии запроса, и в политиках RLS: проверка в коде —
 * первый рубеж, база — второй (SEC-05). Области видимости — только в RLS.
 */
@Injectable()
export class DealsService {
  constructor(private readonly tenantDb: TenantDb) {}

  list(access: AccessContext): Promise<DealView[]> {
    return this.tenantDb.transaction(access, (tx) =>
      tx
        .select(view)
        .from(deals)
        .where(eq(deals.tenantId, access.tenantId))
        .orderBy(desc(deals.createdAt))
        .limit(LIST_LIMIT),
    );
  }

  async get(access: AccessContext, id: string): Promise<DealView | null> {
    const [deal] = await this.tenantDb.transaction(access, (tx) =>
      tx
        .select(view)
        .from(deals)
        .where(and(eq(deals.tenantId, access.tenantId), eq(deals.id, id)))
        .limit(1),
    );
    return deal ?? null;
  }
}
