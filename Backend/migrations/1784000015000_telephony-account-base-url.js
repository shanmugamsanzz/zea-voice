export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumn('telephony_accounts', {
    base_url: {
      type: 'varchar(1000)',
      notNull: true,
      default: 'https://api.plivo.com/v1',
    },
  });
}

export async function down(pgm) {
  pgm.dropColumn('telephony_accounts', 'base_url');
}
