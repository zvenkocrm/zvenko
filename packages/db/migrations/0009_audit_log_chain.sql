-- Ручная миграция: журнал аудита только дописывается, записи компании связаны цепочкой хэшей.
-- SEC-07, F-AUD-04, ADR-0009. drizzle-kit не умеет FORCE RLS, триггеры и права на колонки.

-- FORCE: RLS действует и на владельца таблицы — как у остальных таблиц компаний (ADR-0002).
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- Поле записи для хэша: NULL — байт 00; значение — байт 01, длина текста в байтах
-- (4 байта, старший байт первым) и сам текст в UTF-8. Длина делает разбиение однозначным:
-- поля «ab» + «c» и «a» + «bc» дают разные хэши. То же кодирование — в verifyAuditLog.
CREATE FUNCTION "audit"."hash_field"(value text) RETURNS bytea
  LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE
    WHEN value IS NULL THEN decode('00', 'hex')
    ELSE decode('01', 'hex') || int4send(octet_length(convert_to(value, 'UTF8')))
      || convert_to(value, 'UTF8')
  END
$$;--> statement-breakpoint

-- Дописывание записи. Номер, время и хэши задаёт только этот триггер — присланные значения
-- перезаписываются. Функция работает от владельца схемы: роль приложения не видит и не меняет
-- голову цепочки напрямую. search_path закреплён — SECURITY DEFINER не зависит от вызывающего.
CREATE FUNCTION "audit"."append_entry"() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  head "audit"."chain_heads"%ROWTYPE;
BEGIN
  -- Первая запись компании создаёт голову цепочки. Блокировка строки головы держится
  -- до конца транзакции: записи одной компании идут по очереди, номера — без пропусков,
  -- а откат транзакции не оставляет дыр (голова откатывается вместе с записью).
  INSERT INTO "audit"."chain_heads" ("tenant_id", "seq", "hash")
  VALUES (NEW."tenant_id", 0, decode(repeat('00', 32), 'hex'))
  ON CONFLICT ("tenant_id") DO NOTHING;
  SELECT * INTO STRICT head FROM "audit"."chain_heads"
  WHERE "tenant_id" = NEW."tenant_id" FOR UPDATE;

  NEW."seq" := head."seq" + 1;
  -- Время БД с точностью до миллисекунды. Внутри цепочки оно не идёт назад,
  -- даже если часы сервера перевели.
  NEW."occurred_at" := greatest(date_trunc('milliseconds', clock_timestamp()), head."occurred_at");
  NEW."hash_version" := 1;
  NEW."prev_hash" := head."hash";
  -- Формат 1: SHA-256(хэш предыдущей записи + поля записи в этом порядке).
  NEW."hash" := sha256(
    head."hash"
    || "audit"."hash_field"(NEW."hash_version"::text)
    || "audit"."hash_field"(NEW."tenant_id"::text)
    || "audit"."hash_field"(NEW."seq"::text)
    || "audit"."hash_field"(to_char(NEW."occurred_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    || "audit"."hash_field"(NEW."actor_type")
    || "audit"."hash_field"(NEW."actor_id"::text)
    || "audit"."hash_field"(NEW."action")
    || "audit"."hash_field"(NEW."result")
    || "audit"."hash_field"(NEW."object_type")
    || "audit"."hash_field"(NEW."object_id"::text)
    || "audit"."hash_field"(host(NEW."ip"))
    || "audit"."hash_field"(NEW."user_agent")
    || "audit"."hash_field"(NEW."request_id")
    || "audit"."hash_field"(NEW."details"::text)
  );

  UPDATE "audit"."chain_heads"
  SET "seq" = NEW."seq", "hash" = NEW."hash", "occurred_at" = NEW."occurred_at"
  WHERE "tenant_id" = NEW."tenant_id";
  RETURN NEW;
END $$;--> statement-breakpoint

-- Изменить запись нельзя никому, включая владельца схемы: случайный UPDATE или DELETE
-- в консоли или в миграции не пройдёт. Удаление — только осознанное: очистка по сроку
-- хранения (F-AUD-04) и удаление компании включают zvenko.audit_purge в своей транзакции.
CREATE FUNCTION "audit"."reject_change"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP <> 'UPDATE' AND current_setting('zvenko.audit_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'журнал аудита только дописывается: % запрещён', TG_OP;
END $$;--> statement-breakpoint

CREATE TRIGGER "audit_log_append" BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit"."append_entry"();--> statement-breakpoint
CREATE TRIGGER "audit_log_immutable" BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION "audit"."reject_change"();--> statement-breakpoint
CREATE TRIGGER "audit_log_no_truncate" BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION "audit"."reject_change"();--> statement-breakpoint

-- Схема журнала закрыта. Функции нужны только триггерам; роли приложения — чтение головы
-- цепочки своей компании для проверки целостности (RLS).
REVOKE ALL ON SCHEMA "audit" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "audit"."hash_field"(text), "audit"."append_entry"(), "audit"."reject_change"() FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA "audit" TO "zvenko_app";--> statement-breakpoint
GRANT SELECT ON "audit"."chain_heads" TO "zvenko_app";--> statement-breakpoint

-- Роль приложения читает журнал своей компании и дописывает в него только содержимое записи.
-- UPDATE, DELETE и TRUNCATE не выданы (data-model: «Что проверяем автоматически»).
GRANT SELECT ON "audit_log" TO "zvenko_app";--> statement-breakpoint
GRANT INSERT ("tenant_id", "actor_type", "actor_id", "action", "result", "object_type", "object_id", "ip", "user_agent", "request_id", "details") ON "audit_log" TO "zvenko_app";
