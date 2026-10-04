CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."tenant_directory" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"subdomain" text NOT NULL,
	"region" text NOT NULL,
	CONSTRAINT "tenant_directory_subdomain_unique" UNIQUE("subdomain")
);
--> statement-breakpoint
ALTER TABLE "platform"."tenant_directory" ADD CONSTRAINT "tenant_directory_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;