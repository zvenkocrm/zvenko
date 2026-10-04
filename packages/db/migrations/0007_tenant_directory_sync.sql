-- Ручная миграция: справочник «поддомен → компания» ведётся триггером, права ролей. ADR-0002.

-- Справочник повторяет поддомен и регион компании. Функция работает от владельца схемы,
-- поэтому компанию может создать любая роль платформы — справочник не отстанет.
-- search_path закреплён: SECURITY DEFINER не должна зависеть от путей вызывающего.
CREATE FUNCTION "platform"."sync_tenant_directory"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO "platform"."tenant_directory" ("tenant_id", "subdomain", "region")
  VALUES (NEW."id", NEW."subdomain", NEW."region")
  ON CONFLICT ("tenant_id") DO UPDATE
    SET "subdomain" = EXCLUDED."subdomain", "region" = EXCLUDED."region";
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "platform"."sync_tenant_directory"() FROM PUBLIC;--> statement-breakpoint

-- Удаление компании убирает запись каскадом по внешнему ключу.
CREATE TRIGGER "tenants_sync_directory"
  AFTER INSERT OR UPDATE OF "subdomain", "region" ON "public"."tenants"
  FOR EACH ROW EXECUTE FUNCTION "platform"."sync_tenant_directory"();--> statement-breakpoint

-- Компании, созданные до этой миграции.
INSERT INTO "platform"."tenant_directory" ("tenant_id", "subdomain", "region")
SELECT "id", "subdomain", "region" FROM "public"."tenants"
ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint

-- Справочник читает роль приложения: по адресу сайта определяется компания запроса.
-- Писать в него — только триггеру. Роль входа схему платформы не видит.
REVOKE ALL ON SCHEMA "platform" FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "platform" TO "zvenko_app";--> statement-breakpoint
GRANT SELECT ON "platform"."tenant_directory" TO "zvenko_app";--> statement-breakpoint

-- Поддомен и регион компании меняет только платформа: регион после создания не меняется
-- вовсе (F-TEN-01), поддомен — отдельной процедурой. Приложение меняет только название.
REVOKE UPDATE ON "public"."tenants" FROM "zvenko_app";--> statement-breakpoint
GRANT UPDATE ("name") ON "public"."tenants" TO "zvenko_app";
