export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumn('organizations', {
    per_minute_price: {
      type: 'numeric(12,4)',
      notNull: true,
      default: 0,
    },
  });
  pgm.addConstraint('organizations', 'organizations_per_minute_price_nonnegative', {
    check: 'per_minute_price >= 0',
  });
}

export async function down(pgm) {
  pgm.dropConstraint('organizations', 'organizations_per_minute_price_nonnegative');
  pgm.dropColumn('organizations', 'per_minute_price');
}
