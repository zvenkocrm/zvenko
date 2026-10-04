CREATE TABLE "event_receipts" (
	"tenant_id" uuid NOT NULL,
	"subscriber" text NOT NULL,
	"event_id" uuid NOT NULL,
	"processed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_receipts_tenant_id_subscriber_event_id_pk" PRIMARY KEY("tenant_id","subscriber","event_id"),
	CONSTRAINT "event_receipts_subscriber" CHECK ("event_receipts"."subscriber" ~ '^[a-z][a-z0-9_.-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "event_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_tenant_id_id_pk" PRIMARY KEY("tenant_id","id"),
	CONSTRAINT "outbox_type" CHECK ("outbox"."type" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length("outbox"."type") <= 64),
	CONSTRAINT "outbox_object_type" CHECK ("outbox"."object_type" ~ '^[a-z][a-z_]{0,31}$'),
	CONSTRAINT "outbox_actor" CHECK (("outbox"."actor_type" in ('user', 'support') and "outbox"."actor_id" is not null)
        or ("outbox"."actor_type" = 'system' and "outbox"."actor_id" is null)),
	CONSTRAINT "outbox_data" CHECK (jsonb_typeof("outbox"."data") = 'object' and octet_length("outbox"."data"::text) <= 16384)
);
--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_receipts" ADD CONSTRAINT "event_receipts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_dispatch_order" ON "outbox" USING btree ("id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "event_receipts" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("event_receipts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("event_receipts"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "event_receipts_read" ON "event_receipts" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (true);--> statement-breakpoint
CREATE POLICY "event_receipts_insert" ON "event_receipts" AS PERMISSIVE FOR INSERT TO "zvenko_app" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("outbox"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("outbox"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "outbox_insert" ON "outbox" AS PERMISSIVE FOR INSERT TO "zvenko_app" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "outbox_dispatch" ON "outbox" AS PERMISSIVE FOR ALL TO "zvenko_worker" USING (true) WITH CHECK (true);