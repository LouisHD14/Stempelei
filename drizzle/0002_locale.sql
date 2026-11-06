CREATE TYPE "public"."locale" AS ENUM('de', 'en');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" "locale" DEFAULT 'de' NOT NULL;