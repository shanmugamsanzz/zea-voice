export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE TYPE compliance_policy AS ENUM (
      'standard_hipaa_pci', 'strict_gdpr', 'relaxed_developer'
    );
    CREATE TYPE sip_relay_region AS ENUM ('us_east', 'eu_central', 'apac_south');

    CREATE TABLE platform_settings (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      admin_ip_allowlist cidr[] NOT NULL DEFAULT ARRAY['0.0.0.0/0'::cidr, '::/0'::cidr],
      max_session_timeout_seconds integer NOT NULL DEFAULT 3600,
      compliance_policy compliance_policy NOT NULL DEFAULT 'standard_hipaa_pci',
      sip_relay_region sip_relay_region NOT NULL DEFAULT 'us_east',
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT platform_settings_allowlist_not_empty CHECK (cardinality(admin_ip_allowlist) > 0),
      CONSTRAINT platform_settings_session_timeout_range CHECK (
        max_session_timeout_seconds BETWEEN 300 AND 86400
      )
    );

    INSERT INTO platform_settings (id) VALUES (true);
    CREATE TRIGGER platform_settings_set_updated_at BEFORE UPDATE ON platform_settings
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY;
    CREATE POLICY platform_settings_select_policy ON platform_settings FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service());
    CREATE POLICY platform_settings_write_policy ON platform_settings FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin()) WITH CHECK (zea_is_platform_admin());

    GRANT USAGE ON TYPE compliance_policy, sip_relay_region TO zea_voice_runtime;
    GRANT SELECT, UPDATE ON platform_settings TO zea_voice_runtime;
    COMMENT ON TABLE platform_settings IS 'Singleton Super Admin security, compliance and SIP relay configuration.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP TABLE IF EXISTS platform_settings;
    DROP TYPE IF EXISTS sip_relay_region;
    DROP TYPE IF EXISTS compliance_policy;
  `);
}
