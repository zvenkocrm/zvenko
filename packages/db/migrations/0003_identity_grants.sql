-- Ручная миграция: права ролей на схему identity (drizzle-kit не умеет GRANT и REVOKE). ADR-0006.

-- Пароли, сессии и токены видит только роль модуля входа. Роль приложения в схему не допущена:
-- ошибка или внедрение SQL в коде CRM не откроет хэши паролей и токены сессий.
REVOKE ALL ON SCHEMA "identity" FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "identity" TO "zvenko_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "identity"."sessions", "identity"."accounts", "identity"."verifications" TO "zvenko_identity";--> statement-breakpoint

-- Пользователей создаёт и меняет модуль входа (политика users_identity). Данных компаний
-- он не видит. Удаление пользователя — отдельной процедурой платформы, позже.
GRANT USAGE ON SCHEMA "public" TO "zvenko_identity";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "users" TO "zvenko_identity";
