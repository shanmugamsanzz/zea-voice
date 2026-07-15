export const shorthands = undefined;
export async function up(pgm) {
  pgm.sql('GRANT DELETE ON plivo_callback_events TO zea_voice_runtime;');
}
export async function down(pgm) {
  pgm.sql('REVOKE DELETE ON plivo_callback_events FROM zea_voice_runtime;');
}
