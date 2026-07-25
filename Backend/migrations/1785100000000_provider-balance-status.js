// Historical compatibility marker.
//
// The shared database already records this migration as applied. Its original
// source file is absent from this checkout, so this no-op definition preserves
// node-pg-migrate's ordered history without reapplying schema changes.
export const shorthands = undefined;

export async function up() {}

export async function down() {}
