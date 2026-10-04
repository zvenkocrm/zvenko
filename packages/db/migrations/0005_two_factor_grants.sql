-- Ручная миграция: права роли модуля входа на таблицу второго фактора. ADR-0006, SEC-02.
GRANT SELECT, INSERT, UPDATE, DELETE ON "identity"."two_factors" TO "zvenko_identity";--> statement-breakpoint

-- Новые таблицы схемы identity получают те же права автоматически: таблица без прав не
-- сломает вход молча, а роль приложения по-прежнему в схему не допущена.
ALTER DEFAULT PRIVILEGES IN SCHEMA "identity" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "zvenko_identity";
