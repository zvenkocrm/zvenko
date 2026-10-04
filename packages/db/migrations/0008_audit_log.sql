CREATE SCHEMA "audit";
--> statement-breakpoint
CREATE TABLE "audit"."chain_heads" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"hash" "bytea" NOT NULL,
	"occurred_at" timestamp (3) with time zone
);
--> statement-breakpoint
ALTER TABLE "audit"."chain_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "audit_log" (
	"tenant_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"object_type" text,
	"object_id" uuid,
	"ip" "inet",
	"user_agent" text,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash_version" smallint NOT NULL,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_log_tenant_id_seq_pk" PRIMARY KEY("tenant_id","seq"),
	CONSTRAINT "audit_log_actor" CHECK (("audit_log"."actor_type" in ('user', 'support') and "audit_log"."actor_id" is not null)
        or ("audit_log"."actor_type" in ('system', 'anonymous') and "audit_log"."actor_id" is null)),
	CONSTRAINT "audit_log_action" CHECK ("audit_log"."action" ~ '^[a-z][a-z_]*(\.[a-z][a-z_]*)+$' and char_length("audit_log"."action") <= 64),
	CONSTRAINT "audit_log_result" CHECK ("audit_log"."result" in ('success', 'failure')),
	CONSTRAINT "audit_log_object" CHECK (("audit_log"."object_type" is null) = ("audit_log"."object_id" is null)
        and ("audit_log"."object_type" is null or "audit_log"."object_type" ~ '^[a-z][a-z_]{0,31}$')),
	CONSTRAINT "audit_log_ip" CHECK (masklen("audit_log"."ip") = case family("audit_log"."ip") when 4 then 32 else 128 end),
	CONSTRAINT "audit_log_user_agent" CHECK (char_length("audit_log"."user_agent") <= 512),
	CONSTRAINT "audit_log_request_id" CHECK ("audit_log"."request_id" ~ '^[A-Za-z0-9-]{8,64}$'),
	CONSTRAINT "audit_log_details" CHECK (jsonb_typeof("audit_log"."details") = 'object' and octet_length("audit_log"."details"::text) <= 4096),
	CONSTRAINT "audit_log_hash" CHECK (octet_length("audit_log"."prev_hash") = 32 and octet_length("audit_log"."hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit"."chain_heads" ADD CONSTRAINT "chain_heads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit"."chain_heads" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("audit"."chain_heads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("audit"."chain_heads"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "chain_heads_read" ON "audit"."chain_heads" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "audit_log" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("audit_log"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "audit_log_read" ON "audit_log" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (true);--> statement-breakpoint
CREATE POLICY "audit_log_insert" ON "audit_log" AS PERMISSIVE FOR INSERT TO "zvenko_app" WITH CHECK (true);