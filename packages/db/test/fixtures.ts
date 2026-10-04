import type { Database } from "../src/client.js";
import { newId } from "../src/ids.js";
import { deals, memberships, teams, tenants, users } from "../src/schema/index.js";

/**
 * Две компании. В A — два отдела и три сотрудника, в B — один.
 *
 *   A: отдел A1 — userA1 (сделка dealA1), userA2 (dealA2); отдел A2 — userA3 (dealA3)
 *   B: отдел B1 — userB1 (dealB1)
 */
export const ids = {
  tenantA: newId(),
  tenantB: newId(),
  teamA1: newId(),
  teamA2: newId(),
  teamB1: newId(),
  userA1: newId(),
  userA2: newId(),
  userA3: newId(),
  userB1: newId(),
  dealA1: newId(),
  dealA2: newId(),
  dealA3: newId(),
  dealB1: newId(),
} as const;

/** Данные кладёт владелец схемы — для него RLS не действует. */
export async function seed(owner: Database): Promise<void> {
  await owner.insert(tenants).values([
    { id: ids.tenantA, name: "Компания A", subdomain: "company-a" },
    { id: ids.tenantB, name: "Компания B", subdomain: "company-b" },
  ]);
  await owner.insert(users).values([
    { id: ids.userA1, email: "a1@example.test", name: "A1" },
    { id: ids.userA2, email: "a2@example.test", name: "A2" },
    { id: ids.userA3, email: "a3@example.test", name: "A3" },
    { id: ids.userB1, email: "b1@example.test", name: "B1" },
  ]);
  await owner.insert(teams).values([
    { tenantId: ids.tenantA, id: ids.teamA1, name: "A1" },
    { tenantId: ids.tenantA, id: ids.teamA2, name: "A2" },
    { tenantId: ids.tenantB, id: ids.teamB1, name: "B1" },
  ]);
  await owner.insert(memberships).values([
    { tenantId: ids.tenantA, userId: ids.userA1, teamId: ids.teamA1, role: "manager" },
    { tenantId: ids.tenantA, userId: ids.userA2, teamId: ids.teamA1, role: "manager" },
    { tenantId: ids.tenantA, userId: ids.userA3, teamId: ids.teamA2, role: "manager" },
    { tenantId: ids.tenantB, userId: ids.userB1, teamId: ids.teamB1, role: "owner" },
  ]);
  await owner.insert(deals).values([
    { tenantId: ids.tenantA, id: ids.dealA1, title: "A1", ownerId: ids.userA1, teamId: ids.teamA1 },
    { tenantId: ids.tenantA, id: ids.dealA2, title: "A2", ownerId: ids.userA2, teamId: ids.teamA1 },
    { tenantId: ids.tenantA, id: ids.dealA3, title: "A3", ownerId: ids.userA3, teamId: ids.teamA2 },
    { tenantId: ids.tenantB, id: ids.dealB1, title: "B1", ownerId: ids.userB1, teamId: ids.teamB1 },
  ]);
}
