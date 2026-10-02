export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_sessions
      ALTER COLUMN credits_charged TYPE numeric(24, 8) USING credits_charged::numeric;
    ALTER TABLE call_sessions
      DROP CONSTRAINT IF EXISTS call_sessions_credits_charged_nonnegative,
      ADD CONSTRAINT call_sessions_credits_charged_nonnegative CHECK (credits_charged >= 0);
    COMMENT ON COLUMN call_sessions.credits_charged IS
      'Exact INR-equivalent credits debited from metered provider and telephony usage; one credit equals one INR.';
    COMMENT ON COLUMN call_sessions.credit_price_snapshot_inr IS
      'Legacy field retained only for historical call records. Metered calls use call_metered_usage_costs price snapshots.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE call_sessions
      ALTER COLUMN credits_charged TYPE integer USING trunc(credits_charged)::integer;
  `);
}
