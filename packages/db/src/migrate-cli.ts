/**
 * Применение миграций: `node dist/migrate-cli.js`. Это отдельный шаг развёртывания,
 * он работает от роли-владельца схемы (MIGRATION_DATABASE_URL). Приложение при старте
 * миграции не запускает: у его роли нет прав менять схему.
 */
import pg from "pg";
import { createDatabase } from "./client.js";
import { runMigrations } from "./migrate.js";

const url = process.env.MIGRATION_DATABASE_URL;
if (url === undefined || url === "") {
  console.error("Не задан MIGRATION_DATABASE_URL — адрес БД с ролью-владельцем схемы.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1, application_name: "zvenko-migrate" });
try {
  await runMigrations(createDatabase(pool));
  console.log("Миграции применены.");
} finally {
  await pool.end();
}
