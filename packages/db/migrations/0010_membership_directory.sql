CREATE TABLE "platform"."membership_directory" (
	"user_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	CONSTRAINT "membership_directory_user_id_tenant_id_pk" PRIMARY KEY("user_id","tenant_id")
);
--> statement-breakpoint
ALTER TABLE "platform"."membership_directory" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform"."membership_directory" ADD CONSTRAINT "membership_directory_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."membership_directory" ADD CONSTRAINT "membership_directory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "membership_directory_own" ON "platform"."membership_directory" AS PERMISSIVE FOR SELECT TO "zvenko_app" USING ("platform"."membership_directory"."user_id" = (select nullif(current_setting('app.user_id', true), '')::uuid));