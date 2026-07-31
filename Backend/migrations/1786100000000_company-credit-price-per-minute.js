export const shorthands = undefined;

// Restores the migration name already present in the shared database. The column
// was originally introduced by 1784000014000; this migration makes that dependency
// explicit for databases created from differing historical branches.
export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE organizations
      ADD COLUMN IF NOT EXISTS per_minute_price numeric(12, 4) NOT NULL DEFAULT 0;

    DO $$ BEGIN
      ALTER TABLE organizations
        ADD CONSTRAINT organizations_per_minute_price_nonnegative CHECK (per_minute_price >= 0);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
}

// The column belongs to the earlier foundational migration and must not be removed
// when only this compatibility migration is rolled back.
export async function down() {}

