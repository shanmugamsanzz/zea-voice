// Historical compatibility marker.
//
// This migration is already recorded in deployed databases, but its source
// file was removed from the repository before the conversation-memory work.
// Keep the exact name so node-pg-migrate can validate the immutable migration
// history. The current application does not require an additional schema
// operation from this retired provider-balance debugging migration.
export const shorthands = undefined;
export async function up() {}
export async function down() {}
