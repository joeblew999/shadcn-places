CREATE TABLE `coverage` (
	`locale` text NOT NULL,
	`type` text NOT NULL,
	`named` integer NOT NULL,
	`real` integer NOT NULL,
	PRIMARY KEY(`locale`, `type`)
);
