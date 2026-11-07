CREATE TABLE "apple_registrations" (
	"device_id" text NOT NULL,
	"card_id" uuid NOT NULL,
	"push_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "apple_registrations_device_id_card_id_pk" PRIMARY KEY("device_id","card_id")
);
--> statement-breakpoint
ALTER TABLE "programs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "apple_registrations" ADD CONSTRAINT "apple_registrations_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apple_registrations_card_idx" ON "apple_registrations" USING btree ("card_id");