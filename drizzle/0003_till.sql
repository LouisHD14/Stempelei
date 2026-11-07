CREATE TABLE "pairing_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "till_sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"staff_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_staff_id_staff_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "till_sessions" ADD CONSTRAINT "till_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pairing_codes_business_idx" ON "pairing_codes" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "till_sessions_staff_idx" ON "till_sessions" USING btree ("staff_id");--> statement-breakpoint
CREATE INDEX "till_sessions_device_idx" ON "till_sessions" USING btree ("device_id");