import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Database } from "./client.js";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Применяет миграции. Запускать ролью-владельцем схемы, не ролью приложения. */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder });
}
