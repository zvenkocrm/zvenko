-- Ручная миграция: права на outbox и отметки обработанных событий. ADR-0005.

-- FORCE: RLS действует и на владельца таблиц — как у остальных таблиц компаний (ADR-0002).
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Роль приложения только дописывает события своей компании: прочитать, изменить или удалить
-- события, в том числе чужие, она не может.
GRANT INSERT ON "outbox" TO "zvenko_app";--> statement-breakpoint
-- Отметки обработанных событий — в транзакции обработчика, в контексте компании события.
GRANT SELECT, INSERT ON "event_receipts" TO "zvenko_app";--> statement-breakpoint

-- Диспетчер (роль фоновых задач) читает события всех компаний и удаляет перенесённые
-- в очередь. Других данных компаний он не видит.
GRANT USAGE ON SCHEMA "public" TO "zvenko_worker";--> statement-breakpoint
GRANT SELECT, DELETE ON "outbox" TO "zvenko_worker";
