import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAccess } from "../src/access.js";
import { newId } from "../src/ids.js";
import { tenantDirectory, tenants } from "../src/schema/index.js";
import { pgErrorCode, startTestDatabase, type TestDatabase } from "./database.js";
import { ids, seed } from "./fixtures.js";

const PERMISSION_DENIED = "42501";

let started: TestDatabase | undefined;

function db(): TestDatabase {
  if (!started) throw new Error("тестовая БД не запущена");
  return started;
}

beforeAll(async () => {
  started = await startTestDatabase();
  await seed(started.owner);
});

afterAll(async () => {
  await started?.stop();
});

async function errorCode(work: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await work();
  } catch (error) {
    return pgErrorCode(error);
  }
  return undefined;
}

const adminOfA = {
  tenantId: ids.tenantA,
  userId: ids.userA1,
  teamIds: [ids.teamA1],
  scopes: { deals: { read: "all", write: "all" } },
} as const;

describe("справочник «поддомен → компания» (ADR-0002)", () => {
  it("заполняется сам: и для уже созданных компаний, и для новых", async () => {
    const tenantId = newId();
    await db().owner.insert(tenants).values({ id: tenantId, name: "Новая", subdomain: "novaya" });
    const rows = await db()
      .owner.select({ subdomain: tenantDirectory.subdomain })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(rows).toEqual([{ subdomain: "novaya" }]);

    const seeded = await db().owner.select().from(tenantDirectory);
    expect(seeded.map((row) => row.subdomain)).toEqual(
      expect.arrayContaining(["company-a", "company-b", "novaya"]),
    );
  });

  it("следует за сменой поддомена и исчезает вместе с компанией", async () => {
    const tenantId = newId();
    await db()
      .owner.insert(tenants)
      .values({ id: tenantId, name: "Временная", subdomain: "vremya" });
    await db().owner.update(tenants).set({ subdomain: "vremya-2" }).where(eq(tenants.id, tenantId));
    const [moved] = await db()
      .owner.select({ subdomain: tenantDirectory.subdomain })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(moved?.subdomain).toBe("vremya-2");

    await db().owner.delete(tenants).where(eq(tenants.id, tenantId));
    const gone = await db()
      .owner.select()
      .from(tenantDirectory)
      .where(eq(tenantDirectory.tenantId, tenantId));
    expect(gone).toEqual([]);
  });

  it("роль приложения читает справочник без контекста компании — по адресу сайта", async () => {
    const rows = await db()
      .app.select({ tenantId: tenantDirectory.tenantId })
      .from(tenantDirectory)
      .where(eq(tenantDirectory.subdomain, "company-a"));
    expect(rows).toEqual([{ tenantId: ids.tenantA }]);
  });

  it("писать в справочник роль приложения не может", async () => {
    const code = await errorCode(() =>
      db()
        .app.update(tenantDirectory)
        .set({ tenantId: ids.tenantB })
        .where(eq(tenantDirectory.subdomain, "company-a")),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });

  it("роль входа схему платформы не видит", async () => {
    const code = await errorCode(() => db().identity.select().from(tenantDirectory));
    expect(code).toBe(PERMISSION_DENIED);
  });
});

describe("компания меняет только название (F-TEN-01, F-TEN-03)", () => {
  it("название — можно", async () => {
    await withAccess(db().app, adminOfA, (tx) =>
      tx.update(tenants).set({ name: "Компания A+" }).where(eq(tenants.id, ids.tenantA)),
    );
    const [row] = await db()
      .owner.select({ name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, ids.tenantA));
    expect(row?.name).toBe("Компания A+");
  });

  it.each([
    ["поддомен", { subdomain: "stolen" }],
    ["регион", { region: "eu-central1" }],
  ] as const)("%s — нельзя: это делает только платформа", async (_name, change) => {
    const code = await errorCode(() =>
      withAccess(db().app, adminOfA, (tx) =>
        tx.update(tenants).set(change).where(eq(tenants.id, ids.tenantA)),
      ),
    );
    expect(code).toBe(PERMISSION_DENIED);
  });
});
