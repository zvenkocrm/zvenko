import { describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { membershipDirectory } from "../src/schema/index.js";
import { startTestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

/**
 * Перенос данных миграциями — ролью-владельцем без прав суперпользователя, как в продакшене.
 * FORCE RLS скрывает строки компаний и от владельца таблицы: перенос, который этого
 * не учитывает, в продакшене молча переносит ничего.
 */
describe("перенос данных миграциями", () => {
  it("справочник «пользователь → компании» получает членства, созданные до него", async () => {
    const database = await startTestDatabase({ until: "0010_membership_directory" });
    try {
      await seed(database.admin);
      await runMigrations(database.owner);

      const rows = await database.admin.select().from(membershipDirectory);
      expect(rows.map((row) => `${row.tenantId}:${row.userId}`).sort()).toEqual(
        [
          `${ids.tenantA}:${ids.userA1}`,
          `${ids.tenantA}:${ids.userA2}`,
          `${ids.tenantA}:${ids.userA3}`,
          `${ids.tenantB}:${ids.userB1}`,
        ].sort(),
      );
      // На время переноса FORCE RLS снимался — после миграции он снова включён.
      const forced = await database.adminPool.query<{ forced: boolean }>(
        "select relforcerowsecurity as forced from pg_class where oid = 'memberships'::regclass",
      );
      expect(forced.rows).toEqual([{ forced: true }]);
    } finally {
      await database.stop();
    }
  });
});
