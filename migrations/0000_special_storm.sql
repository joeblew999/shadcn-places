CREATE TABLE `name` (
	`place_id` text NOT NULL,
	`locale` text NOT NULL,
	`value` text NOT NULL,
	`source` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`place_id`, `locale`),
	FOREIGN KEY (`place_id`) REFERENCES `place`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `name_locale_kind_idx` ON `name` (`locale`,`kind`);--> statement-breakpoint
CREATE TABLE `place` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`pivot` text NOT NULL,
	`parent_id` text,
	`country_code` text,
	`lat` real,
	`lon` real,
	`population` integer,
	`wikidata_id` text
);
--> statement-breakpoint
CREATE INDEX `place_parent_idx` ON `place` (`parent_id`);--> statement-breakpoint
CREATE INDEX `place_country_type_idx` ON `place` (`country_code`,`type`);--> statement-breakpoint
CREATE INDEX `place_prefix_idx` ON `place` (`country_code`,`type`,`pivot`);