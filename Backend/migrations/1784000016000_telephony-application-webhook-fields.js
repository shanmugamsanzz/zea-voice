export const shorthands = undefined;

export async function up(pgm) {
  pgm.addColumns('telephony_accounts', {
    application_id: { type: 'varchar(240)', notNull: true, default: '' },
    answer_url: { type: 'varchar(1000)', notNull: true, default: '' },
    hangup_url: { type: 'varchar(1000)', notNull: true, default: '' },
    recording_callback_url: { type: 'varchar(1000)', notNull: true, default: '' },
  });
}

export async function down(pgm) {
  pgm.dropColumns('telephony_accounts', [
    'application_id', 'answer_url', 'hangup_url', 'recording_callback_url',
  ]);
}
