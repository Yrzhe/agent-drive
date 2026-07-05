CREATE TABLE `agent_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key_jwk` text NOT NULL,
	`private_key_jwk` text NOT NULL,
	`algorithm` text DEFAULT 'Ed25519' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
