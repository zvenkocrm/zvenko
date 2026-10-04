CREATE TABLE "deals" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"title" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"team_id" uuid,
	"amount" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deals_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "deals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "teams" (
	"tenant_id" uuid NOT NULL,
	"id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_tenant_id_id_pk" PRIMARY KEY("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "teams" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"subdomain" text NOT NULL,
	"region" text DEFAULT 'ru-central1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deals" ADD CONSTRAINT "deals_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_team_fk" FOREIGN KEY ("tenant_id","team_id") REFERENCES "public"."teams"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deals_owner_idx" ON "deals" USING btree ("tenant_id","owner_id");--> statement-breakpoint
CREATE INDEX "deals_team_idx" ON "deals" USING btree ("tenant_id","team_id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "deals" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("deals"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("deals"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "deals_read" ON "deals" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (((select current_setting('app.scope_deals_read', true)) = 'all' or ((select current_setting('app.scope_deals_read', true)) = 'team' and "deals"."team_id" = any((select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[])) or "deals"."owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "deals_insert" ON "deals" AS PERMISSIVE FOR INSERT TO "zvenko_app" WITH CHECK (((select current_setting('app.scope_deals_write', true)) = 'all' or ((select current_setting('app.scope_deals_write', true)) = 'team' and "deals"."team_id" = any((select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[])) or "deals"."owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "deals_update" ON "deals" AS PERMISSIVE FOR UPDATE TO "zvenko_app" USING (((select current_setting('app.scope_deals_write', true)) = 'all' or ((select current_setting('app.scope_deals_write', true)) = 'team' and "deals"."team_id" = any((select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[])) or "deals"."owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid))) WITH CHECK (((select current_setting('app.scope_deals_write', true)) = 'all' or ((select current_setting('app.scope_deals_write', true)) = 'team' and "deals"."team_id" = any((select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[])) or "deals"."owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "deals_delete" ON "deals" AS PERMISSIVE FOR DELETE TO "zvenko_app" USING (((select current_setting('app.scope_deals_write', true)) = 'all' or ((select current_setting('app.scope_deals_write', true)) = 'team' and "deals"."team_id" = any((select string_to_array(nullif(current_setting('app.team_ids', true), ''), ',')::uuid[])::uuid[])) or "deals"."owner_id" = (select nullif(current_setting('app.user_id', true), '')::uuid)));--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memberships" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("memberships"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "memberships_tenant_wide" ON "memberships" AS PERMISSIVE FOR ALL TO "zvenko_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "teams" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("teams"."tenant_id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "teams_tenant_wide" ON "teams" AS PERMISSIVE FOR ALL TO "zvenko_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "tenants" AS RESTRICTIVE FOR ALL TO "zvenko_app" USING ("tenants"."id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid)) WITH CHECK ("tenants"."id" = (select nullif(current_setting('app.tenant_id', true), '')::uuid));--> statement-breakpoint
CREATE POLICY "tenants_read" ON "tenants" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (true);--> statement-breakpoint
CREATE POLICY "tenants_update" ON "tenants" AS PERMISSIVE FOR UPDATE TO "zvenko_app" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "users_visible_in_tenant" ON "users" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING (exists (select 1 from memberships m where m.user_id = "users"."id" and m.tenant_id = (select nullif(current_setting('app.tenant_id', true), '')::uuid)));