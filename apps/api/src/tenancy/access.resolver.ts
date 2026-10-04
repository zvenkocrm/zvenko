import { Inject, Injectable } from "@nestjs/common";
import { type AccessContext, and, eq, memberships } from "@zvenko/db";

import type { Logger } from "pino";
import { LOGGER } from "../config/config.module.js";
import { ROLE_SCOPES, isRole } from "./roles.js";
import { TenantDb } from "./tenant-db.js";

/** Минимальный профиль, чтобы прочитать своё членство: RLS пускает только в строки этой компании. */
const membershipProbe = (tenantId: string, userId: string): AccessContext => ({
  tenantId,
  userId,
  teamIds: [],
  scopes: { deals: { read: "own", write: "own" } },
});

/**
 * Профиль доступа сотрудника в компании — по его членству и роли.
 * Считается на каждый запрос: одно чтение по первичному ключу, так что отключение сотрудника
 * и смена роли действуют сразу (F-USR-05, F-USR-06). Кэш появится, если упрёмся в PERF-06.
 */
@Injectable()
export class AccessResolver {
  constructor(
    private readonly tenantDb: TenantDb,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** null — пользователь не работает в этой компании или у него неизвестная роль. */
  async resolve(userId: string, tenantId: string): Promise<AccessContext | null> {
    const [membership] = await this.tenantDb.transaction(membershipProbe(tenantId, userId), (tx) =>
      tx
        .select({ role: memberships.role, teamId: memberships.teamId })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)))
        .limit(1),
    );
    if (!membership) return null;
    if (!isRole(membership.role)) {
      // Закрываем доступ, а не угадываем права: неизвестная роль — ошибка данных.
      this.logger.warn({ tenantId, userId }, "неизвестная роль сотрудника — доступ закрыт");
      return null;
    }
    return {
      tenantId,
      userId,
      teamIds: membership.teamId === null ? [] : [membership.teamId],
      scopes: ROLE_SCOPES[membership.role],
    };
  }
}
