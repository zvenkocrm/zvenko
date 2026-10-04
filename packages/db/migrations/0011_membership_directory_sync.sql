-- Ручная миграция: справочник «пользователь → компании» ведётся триггером, права ролей.
-- D30, F-AUTH-06. Как справочник поддоменов (0007).

-- Функция работает от владельца схемы: членства меняет роль приложения, а писать
-- в справочник она не может. search_path закреплён — SECURITY DEFINER не зависит
-- от путей вызывающего.
CREATE FUNCTION "platform"."sync_membership_directory"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM "platform"."membership_directory"
    WHERE "user_id" = OLD."user_id" AND "tenant_id" = OLD."tenant_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO "platform"."membership_directory" ("user_id", "tenant_id")
    VALUES (NEW."user_id", NEW."tenant_id")
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "platform"."sync_membership_directory"() FROM PUBLIC;--> statement-breakpoint

CREATE TRIGGER "memberships_sync_directory"
  AFTER INSERT OR DELETE OR UPDATE OF "user_id", "tenant_id" ON "public"."memberships"
  FOR EACH ROW EXECUTE FUNCTION "platform"."sync_membership_directory"();--> statement-breakpoint

-- Членства, созданные до этой миграции. FORCE RLS скрывает чужие строки и от владельца
-- таблицы, поэтому на время переноса он снимается — в той же транзакции миграции.
ALTER TABLE "public"."memberships" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "platform"."membership_directory" ("user_id", "tenant_id")
SELECT "user_id", "tenant_id" FROM "public"."memberships"
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "public"."memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Роль приложения читает справочник — только строки пользователя из контекста (RLS).
-- Писать в него — только триггеру. Роль входа схему платформы не видит.
GRANT SELECT ON "platform"."membership_directory" TO "zvenko_app";
