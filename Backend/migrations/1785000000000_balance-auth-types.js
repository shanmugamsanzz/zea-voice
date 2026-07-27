// Historical compatibility marker.
//
// This migration is already recorded as applied in the shared database, but its
// source file was absent from this checkout. Keep this no-op definition so
// node-pg-migrate can validate the ordered migration history. Do not place new
// schema changes in this file.
export const shorthands = undefined;

export async function up() {}

export async function down() {}
