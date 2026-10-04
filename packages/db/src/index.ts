export { withAccess, withUser, type AccessContext, type Scope } from "./access.js";
export {
  appendAuditEntry,
  verifyAuditLog,
  type AppendedAuditEntry,
  type AuditActor,
  type AuditEntry,
  type AuditJson,
  type AuditResult,
  type AuditVerification,
} from "./audit.js";
export { createDatabase, type Database, type Transaction } from "./client.js";
export { newId } from "./ids.js";
export { migrationsFolder, runMigrations } from "./migrate.js";
export * from "./schema/index.js";
// Операторы запросов — из той же копии drizzle-orm, что и схема: иначе типы таблиц
// и условий не совпадут. Другие пакеты импортируют drizzle-orm только отсюда.
export { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
