export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zea_voice_runtime') THEN
        CREATE ROLE zea_voice_runtime
          NOLOGIN
          NOSUPERUSER
          NOCREATEDB
          NOCREATEROLE
          NOINHERIT
          NOBYPASSRLS;
      END IF;
    END
    $$;

    DO $$
    BEGIN
      EXECUTE format('GRANT zea_voice_runtime TO %I', current_user);
    END
    $$;

    CREATE TYPE tenant_status AS ENUM ('pending', 'active', 'suspended', 'archived');
    CREATE TYPE workspace_status AS ENUM ('active', 'inactive', 'archived');
    CREATE TYPE billing_tier AS ENUM ('starter', 'pro', 'enterprise');
    CREATE TYPE audit_actor_type AS ENUM ('user', 'system', 'api');
    CREATE TYPE audit_outcome AS ENUM ('success', 'failure');

    CREATE OR REPLACE FUNCTION zea_current_tenant_id()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    $$;

    CREATE OR REPLACE FUNCTION zea_is_platform_admin()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT COALESCE(
        NULLIF(current_setting('app.is_platform_admin', true), '')::boolean,
        false
      )
    $$;

    CREATE OR REPLACE FUNCTION zea_set_updated_at()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END
    $$;

    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(160) NOT NULL,
      slug varchar(100) NOT NULL,
      status tenant_status NOT NULL DEFAULT 'pending',
      timezone varchar(64) NOT NULL DEFAULT 'UTC',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT tenants_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT tenants_slug_unique UNIQUE (slug)
    );

    CREATE TABLE organizations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      name varchar(200) NOT NULL,
      legal_name varchar(240),
      first_name varchar(100),
      last_name varchar(100),
      primary_email varchar(320),
      business_phone varchar(40),
      website varchar(500),
      billing_tier billing_tier NOT NULL DEFAULT 'starter',
      address_line1 varchar(300),
      address_line2 varchar(300),
      state varchar(120),
      country varchar(120),
      postal_code varchar(30),
      timezone varchar(64) NOT NULL DEFAULT 'UTC',
      status tenant_status NOT NULL DEFAULT 'pending',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT organizations_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
      CONSTRAINT organizations_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT organizations_primary_email_lowercase
        CHECK (primary_email IS NULL OR primary_email = lower(primary_email)),
      CONSTRAINT organizations_one_per_tenant UNIQUE (tenant_id),
      CONSTRAINT organizations_tenant_id_id_unique UNIQUE (tenant_id, id)
    );

    CREATE TABLE workspaces (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      organization_id uuid NOT NULL,
      name varchar(160) NOT NULL,
      slug varchar(100) NOT NULL,
      status workspace_status NOT NULL DEFAULT 'active',
      is_default boolean NOT NULL DEFAULT false,
      timezone varchar(64) NOT NULL DEFAULT 'UTC',
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT workspaces_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
      CONSTRAINT workspaces_organization_tenant_fk
        FOREIGN KEY (tenant_id, organization_id)
        REFERENCES organizations(tenant_id, id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      CONSTRAINT workspaces_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT workspaces_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      CONSTRAINT workspaces_tenant_slug_unique UNIQUE (tenant_id, slug),
      CONSTRAINT workspaces_tenant_id_id_unique UNIQUE (tenant_id, id)
    );

    CREATE UNIQUE INDEX workspaces_one_default_per_tenant_idx
      ON workspaces (tenant_id)
      WHERE is_default = true AND deleted_at IS NULL;

    CREATE TABLE tenant_settings (
      tenant_id uuid PRIMARY KEY,
      default_workspace_id uuid,
      locale varchar(20) NOT NULL DEFAULT 'en-US',
      currency char(3) NOT NULL DEFAULT 'USD',
      date_format varchar(30) NOT NULL DEFAULT 'YYYY-MM-DD',
      recording_enabled boolean NOT NULL DEFAULT true,
      data_retention_days integer NOT NULL DEFAULT 365,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_settings_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT tenant_settings_default_workspace_tenant_fk
        FOREIGN KEY (tenant_id, default_workspace_id)
        REFERENCES workspaces(tenant_id, id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT tenant_settings_currency_uppercase CHECK (currency = upper(currency)),
      CONSTRAINT tenant_settings_retention_positive CHECK (data_retention_days >= 1)
    );

    CREATE TABLE tenant_limits (
      tenant_id uuid PRIMARY KEY,
      max_campaign_concurrency integer NOT NULL DEFAULT 20,
      max_total_concurrency integer NOT NULL DEFAULT 20,
      max_agents integer NOT NULL DEFAULT 50,
      max_users integer NOT NULL DEFAULT 50,
      max_phone_numbers integer NOT NULL DEFAULT 20,
      max_campaigns integer NOT NULL DEFAULT 100,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_limits_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT tenant_limits_campaign_concurrency_positive
        CHECK (max_campaign_concurrency >= 1),
      CONSTRAINT tenant_limits_total_concurrency_positive
        CHECK (max_total_concurrency >= 1),
      CONSTRAINT tenant_limits_campaign_within_total
        CHECK (max_campaign_concurrency <= max_total_concurrency),
      CONSTRAINT tenant_limits_agents_nonnegative CHECK (max_agents >= 0),
      CONSTRAINT tenant_limits_users_nonnegative CHECK (max_users >= 0),
      CONSTRAINT tenant_limits_phone_numbers_nonnegative CHECK (max_phone_numbers >= 0),
      CONSTRAINT tenant_limits_campaigns_nonnegative CHECK (max_campaigns >= 0)
    );

    CREATE TABLE audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid,
      workspace_id uuid,
      actor_user_id uuid,
      actor_type audit_actor_type NOT NULL,
      action varchar(160) NOT NULL,
      entity_type varchar(120) NOT NULL,
      entity_id varchar(160),
      outcome audit_outcome NOT NULL DEFAULT 'success',
      before_data jsonb,
      after_data jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      request_id varchar(100),
      ip_address inet,
      user_agent text,
      error_message text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT audit_logs_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
      CONSTRAINT audit_logs_workspace_tenant_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id)
        DEFERRABLE INITIALLY DEFERRED,
      CONSTRAINT audit_logs_action_not_blank CHECK (btrim(action) <> ''),
      CONSTRAINT audit_logs_entity_type_not_blank CHECK (btrim(entity_type) <> ''),
      CONSTRAINT audit_logs_workspace_requires_tenant
        CHECK (workspace_id IS NULL OR tenant_id IS NOT NULL)
    );

    CREATE INDEX tenants_status_idx ON tenants (status) WHERE deleted_at IS NULL;
    CREATE INDEX organizations_tenant_status_idx ON organizations (tenant_id, status);
    CREATE INDEX workspaces_tenant_status_idx ON workspaces (tenant_id, status);
    CREATE INDEX audit_logs_tenant_created_at_idx ON audit_logs (tenant_id, created_at DESC);
    CREATE INDEX audit_logs_entity_idx ON audit_logs (tenant_id, entity_type, entity_id);
    CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
    CREATE INDEX audit_logs_request_idx ON audit_logs (request_id) WHERE request_id IS NOT NULL;

    CREATE TRIGGER tenants_set_updated_at
      BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER organizations_set_updated_at
      BEFORE UPDATE ON organizations
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER workspaces_set_updated_at
      BEFORE UPDATE ON workspaces
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER tenant_settings_set_updated_at
      BEFORE UPDATE ON tenant_settings
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER tenant_limits_set_updated_at
      BEFORE UPDATE ON tenant_limits
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
    ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
    ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
    ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_settings ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_settings FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_limits ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_limits FORCE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

    CREATE POLICY tenants_isolation_policy ON tenants
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR id = zea_current_tenant_id());

    CREATE POLICY organizations_isolation_policy ON organizations
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    CREATE POLICY workspaces_isolation_policy ON workspaces
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    CREATE POLICY tenant_settings_isolation_policy ON tenant_settings
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    CREATE POLICY tenant_limits_isolation_policy ON tenant_limits
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id())
      WITH CHECK (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    CREATE POLICY audit_logs_select_policy ON audit_logs
      FOR SELECT TO zea_voice_runtime
      USING (zea_is_platform_admin() OR tenant_id = zea_current_tenant_id());

    CREATE POLICY audit_logs_insert_policy ON audit_logs
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        zea_is_platform_admin()
        OR (tenant_id IS NOT NULL AND tenant_id = zea_current_tenant_id())
      );

    GRANT USAGE ON SCHEMA public TO zea_voice_runtime;
    GRANT USAGE ON TYPE tenant_status, workspace_status, billing_tier,
      audit_actor_type, audit_outcome TO zea_voice_runtime;
    GRANT EXECUTE ON FUNCTION zea_current_tenant_id() TO zea_voice_runtime;
    GRANT EXECUTE ON FUNCTION zea_is_platform_admin() TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON tenants, organizations, workspaces, tenant_settings, tenant_limits
      TO zea_voice_runtime;
    GRANT SELECT, INSERT ON audit_logs TO zea_voice_runtime;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO zea_voice_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO zea_voice_runtime;

    COMMENT ON TABLE tenants IS 'Top-level security and data-isolation boundary for one company.';
    COMMENT ON TABLE organizations IS 'Business identity owned by a tenant; Phase 1 allows one organization per tenant.';
    COMMENT ON TABLE workspaces IS 'Operational workspace within a tenant organization.';
    COMMENT ON TABLE tenant_settings IS 'One row of platform settings for each tenant.';
    COMMENT ON TABLE tenant_limits IS 'Super Admin controlled tenant resource and concurrency limits.';
    COMMENT ON TABLE audit_logs IS 'Append-only tenant and platform activity history for application roles.';
    COMMENT ON FUNCTION zea_current_tenant_id() IS 'Reads the transaction-local app.current_tenant_id used by RLS policies.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM zea_voice_runtime;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      REVOKE USAGE, SELECT ON SEQUENCES FROM zea_voice_runtime;

    DROP TABLE IF EXISTS audit_logs;
    DROP TABLE IF EXISTS tenant_settings;
    DROP TABLE IF EXISTS tenant_limits;
    DROP TABLE IF EXISTS workspaces;
    DROP TABLE IF EXISTS organizations;
    DROP TABLE IF EXISTS tenants;

    DROP FUNCTION IF EXISTS zea_set_updated_at();
    DROP FUNCTION IF EXISTS zea_is_platform_admin();
    DROP FUNCTION IF EXISTS zea_current_tenant_id();

    DROP TYPE IF EXISTS audit_outcome;
    DROP TYPE IF EXISTS audit_actor_type;
    DROP TYPE IF EXISTS billing_tier;
    DROP TYPE IF EXISTS workspace_status;
    DROP TYPE IF EXISTS tenant_status;

    REVOKE ALL ON SCHEMA public FROM zea_voice_runtime;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zea_voice_runtime') THEN
        EXECUTE format('REVOKE zea_voice_runtime FROM %I', current_user);
        DROP ROLE zea_voice_runtime;
      END IF;
    END
    $$;
  `);
}
