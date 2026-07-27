export const shorthands = undefined;

const THIRTY_DAYS_SECONDS = 2_592_000;
const ONE_DAY_SECONDS = 86_400;

export async function up(pgm) {
  pgm.sql(`
    ALTER TABLE platform_settings
      DROP CONSTRAINT IF EXISTS platform_settings_session_timeout_range;

    ALTER TABLE platform_settings
      ALTER COLUMN max_session_timeout_seconds SET DEFAULT ${THIRTY_DAYS_SECONDS};

    UPDATE platform_settings
       SET max_session_timeout_seconds = ${THIRTY_DAYS_SECONDS}
     WHERE id = true;

    ALTER TABLE platform_settings
      ADD CONSTRAINT platform_settings_session_timeout_range CHECK (
        max_session_timeout_seconds BETWEEN 300 AND ${THIRTY_DAYS_SECONDS}
      );
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE platform_settings
      DROP CONSTRAINT IF EXISTS platform_settings_session_timeout_range;

    UPDATE platform_settings
       SET max_session_timeout_seconds = ${ONE_DAY_SECONDS}
     WHERE max_session_timeout_seconds > ${ONE_DAY_SECONDS};

    ALTER TABLE platform_settings
      ALTER COLUMN max_session_timeout_seconds SET DEFAULT 3600;

    ALTER TABLE platform_settings
      ADD CONSTRAINT platform_settings_session_timeout_range CHECK (
        max_session_timeout_seconds BETWEEN 300 AND ${ONE_DAY_SECONDS}
      );
  `);
}
