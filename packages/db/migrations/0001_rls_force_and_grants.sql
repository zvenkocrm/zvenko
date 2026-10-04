-- Ручная миграция (drizzle-kit не умеет FORCE RLS и GRANT). ADR-0002.

-- FORCE: RLS действует и на владельца таблиц. Если приложение по ошибке запустят
-- ролью-владельцем, изоляция компаний всё равно сохранится.
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "teams" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Права роли приложения — минимально необходимые. Роль создаёт инфраструктура (IaC).
-- Компании создаёт и удаляет модуль платформы отдельной ролью; приложение — только читает и меняет свою.
-- Пользователей создаёт модуль identity отдельной ролью; приложение — только читает сотрудников своей компании.
GRANT USAGE ON SCHEMA "public" TO "zvenko_app";--> statement-breakpoint
GRANT SELECT, UPDATE ON "tenants" TO "zvenko_app";--> statement-breakpoint
GRANT SELECT ON "users" TO "zvenko_app";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "teams", "memberships", "deals" TO "zvenko_app";
