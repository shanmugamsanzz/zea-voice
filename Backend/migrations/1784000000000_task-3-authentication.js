export const shorthands = undefined;

export async function up(pgm) {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS citext;

    CREATE TYPE user_status AS ENUM ('pending', 'active', 'suspended', 'archived');
    CREATE TYPE platform_role AS ENUM ('super_admin');
    CREATE TYPE membership_role AS ENUM ('company_developer', 'company_user');
    CREATE TYPE membership_status AS ENUM ('invited', 'active', 'suspended', 'removed');

    CREATE OR REPLACE FUNCTION zea_current_user_id()
    RETURNS uuid
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid
    $$;

    CREATE OR REPLACE FUNCTION zea_is_auth_service()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT COALESCE(
        NULLIF(current_setting('app.is_auth_service', true), '')::boolean,
        false
      )
    $$;

    CREATE OR REPLACE FUNCTION zea_can_manage_users()
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SET search_path = pg_catalog, public
    AS $$
      SELECT COALESCE(
        NULLIF(current_setting('app.can_manage_users', true), '')::boolean,
        false
      )
    $$;

    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email citext NOT NULL,
      password_hash varchar(255) NOT NULL,
      first_name varchar(100) NOT NULL,
      last_name varchar(100) NOT NULL,
      status user_status NOT NULL DEFAULT 'pending',
      platform_role platform_role,
      email_verified_at timestamptz,
      password_changed_at timestamptz NOT NULL DEFAULT now(),
      last_login_at timestamptz,
      failed_login_attempts integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT users_email_unique UNIQUE (email),
      CONSTRAINT users_email_not_blank CHECK (btrim(email::text) <> ''),
      CONSTRAINT users_first_name_not_blank CHECK (btrim(first_name) <> ''),
      CONSTRAINT users_last_name_not_blank CHECK (btrim(last_name) <> ''),
      CONSTRAINT users_failed_login_attempts_nonnegative CHECK (failed_login_attempts >= 0)
    );

    ALTER TABLE users
      ADD CONSTRAINT users_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

    CREATE TABLE tenant_memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      workspace_id uuid NOT NULL,
      user_id uuid NOT NULL,
      role membership_role NOT NULL,
      status membership_status NOT NULL DEFAULT 'invited',
      invited_by uuid,
      invited_at timestamptz NOT NULL DEFAULT now(),
      joined_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT tenant_memberships_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT tenant_memberships_workspace_tenant_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id)
        ON DELETE RESTRICT,
      CONSTRAINT tenant_memberships_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
      CONSTRAINT tenant_memberships_invited_by_fk
        FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL,
      CONSTRAINT tenant_memberships_one_per_tenant_user UNIQUE (tenant_id, user_id),
      CONSTRAINT tenant_memberships_id_tenant_workspace_user_unique
        UNIQUE (id, tenant_id, workspace_id, user_id)
    );

    CREATE TABLE auth_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      membership_id uuid,
      tenant_id uuid,
      workspace_id uuid,
      access_token_hash char(64) NOT NULL,
      refresh_token_hash char(64) NOT NULL,
      access_expires_at timestamptz NOT NULL,
      refresh_expires_at timestamptz NOT NULL,
      last_used_at timestamptz NOT NULL DEFAULT now(),
      ip_address inet,
      user_agent text,
      revoked_at timestamptz,
      revoke_reason varchar(160),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT auth_sessions_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT auth_sessions_membership_fk
        FOREIGN KEY (membership_id) REFERENCES tenant_memberships(id) ON DELETE CASCADE,
      CONSTRAINT auth_sessions_tenant_fk
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
      CONSTRAINT auth_sessions_workspace_tenant_fk
        FOREIGN KEY (tenant_id, workspace_id)
        REFERENCES workspaces(tenant_id, id)
        ON DELETE CASCADE,
      CONSTRAINT auth_sessions_access_token_unique UNIQUE (access_token_hash),
      CONSTRAINT auth_sessions_refresh_token_unique UNIQUE (refresh_token_hash),
      CONSTRAINT auth_sessions_membership_context_complete CHECK (
        (membership_id IS NULL AND tenant_id IS NULL AND workspace_id IS NULL)
        OR
        (membership_id IS NOT NULL AND tenant_id IS NOT NULL AND workspace_id IS NOT NULL)
      ),
      CONSTRAINT auth_sessions_expiry_order CHECK (access_expires_at < refresh_expires_at)
    );

    CREATE TABLE password_reset_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      token_hash char(64) NOT NULL,
      expires_at timestamptz NOT NULL,
      used_at timestamptz,
      requested_ip inet,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT password_reset_tokens_user_fk
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      CONSTRAINT password_reset_tokens_hash_unique UNIQUE (token_hash)
    );

    ALTER TABLE tenants
      ADD CONSTRAINT tenants_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_created_by_fk
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE audit_logs
      ADD CONSTRAINT audit_logs_actor_user_fk
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL;

    CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
    CREATE INDEX users_platform_role_idx ON users (platform_role) WHERE platform_role IS NOT NULL;
    CREATE INDEX tenant_memberships_user_status_idx
      ON tenant_memberships (user_id, status) WHERE deleted_at IS NULL;
    CREATE INDEX tenant_memberships_tenant_role_status_idx
      ON tenant_memberships (tenant_id, role, status) WHERE deleted_at IS NULL;
    CREATE INDEX auth_sessions_user_active_idx
      ON auth_sessions (user_id, refresh_expires_at DESC) WHERE revoked_at IS NULL;
    CREATE INDEX auth_sessions_access_lookup_idx
      ON auth_sessions (access_token_hash, access_expires_at) WHERE revoked_at IS NULL;
    CREATE INDEX auth_sessions_refresh_lookup_idx
      ON auth_sessions (refresh_token_hash, refresh_expires_at) WHERE revoked_at IS NULL;
    CREATE INDEX password_reset_tokens_active_idx
      ON password_reset_tokens (user_id, expires_at) WHERE used_at IS NULL;

    CREATE TRIGGER users_set_updated_at
      BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();
    CREATE TRIGGER tenant_memberships_set_updated_at
      BEFORE UPDATE ON tenant_memberships
      FOR EACH ROW EXECUTE FUNCTION zea_set_updated_at();

    ALTER TABLE users ENABLE ROW LEVEL SECURITY;
    ALTER TABLE users FORCE ROW LEVEL SECURITY;
    ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
    ALTER TABLE tenant_memberships FORCE ROW LEVEL SECURITY;
    ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

    CREATE POLICY users_select_policy ON users
      FOR SELECT TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR id = zea_current_user_id()
      );

    CREATE POLICY users_insert_policy ON users
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (zea_is_platform_admin() OR zea_can_manage_users());

    CREATE POLICY users_update_policy ON users
      FOR UPDATE TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service() OR zea_can_manage_users())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service() OR zea_can_manage_users());

    CREATE POLICY users_delete_policy ON users
      FOR DELETE TO zea_voice_runtime
      USING (zea_is_platform_admin());

    CREATE POLICY tenant_memberships_select_policy ON tenant_memberships
      FOR SELECT TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR (
          tenant_id = zea_current_tenant_id()
          AND (user_id = zea_current_user_id() OR zea_can_manage_users())
        )
      );

    CREATE POLICY tenant_memberships_insert_policy ON tenant_memberships
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        zea_is_platform_admin()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      );

    CREATE POLICY tenant_memberships_update_policy ON tenant_memberships
      FOR UPDATE TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      )
      WITH CHECK (
        zea_is_platform_admin()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      );

    CREATE POLICY tenant_memberships_delete_policy ON tenant_memberships
      FOR DELETE TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR (tenant_id = zea_current_tenant_id() AND zea_can_manage_users())
      );

    CREATE POLICY auth_sessions_policy ON auth_sessions
      FOR ALL TO zea_voice_runtime
      USING (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR user_id = zea_current_user_id()
      )
      WITH CHECK (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR user_id = zea_current_user_id()
      );

    CREATE POLICY password_reset_tokens_policy ON password_reset_tokens
      FOR ALL TO zea_voice_runtime
      USING (zea_is_platform_admin() OR zea_is_auth_service())
      WITH CHECK (zea_is_platform_admin() OR zea_is_auth_service());

    DROP POLICY audit_logs_insert_policy ON audit_logs;
    CREATE POLICY audit_logs_insert_policy ON audit_logs
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        zea_is_platform_admin()
        OR zea_is_auth_service()
        OR (tenant_id IS NOT NULL AND tenant_id = zea_current_tenant_id())
      );

    GRANT USAGE ON TYPE user_status, platform_role, membership_role,
      membership_status TO zea_voice_runtime;
    GRANT EXECUTE ON FUNCTION zea_current_user_id() TO zea_voice_runtime;
    GRANT EXECUTE ON FUNCTION zea_is_auth_service() TO zea_voice_runtime;
    GRANT EXECUTE ON FUNCTION zea_can_manage_users() TO zea_voice_runtime;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON users, tenant_memberships, auth_sessions, password_reset_tokens
      TO zea_voice_runtime;

    COMMENT ON TABLE users IS 'Global identities; company access is granted only through tenant memberships.';
    COMMENT ON TABLE tenant_memberships IS 'Tenant and workspace role assignment for a company developer or user.';
    COMMENT ON TABLE auth_sessions IS 'Hashed opaque access and refresh sessions; raw tokens are never stored.';
    COMMENT ON TABLE password_reset_tokens IS 'Hashed, expiring, single-use password reset tokens.';
  `);
}

export async function down(pgm) {
  pgm.sql(`
    ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_user_fk;
    ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_created_by_fk;
    ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_created_by_fk;
    ALTER TABLE tenants DROP CONSTRAINT IF EXISTS tenants_created_by_fk;

    DROP POLICY IF EXISTS audit_logs_insert_policy ON audit_logs;
    CREATE POLICY audit_logs_insert_policy ON audit_logs
      FOR INSERT TO zea_voice_runtime
      WITH CHECK (
        zea_is_platform_admin()
        OR (tenant_id IS NOT NULL AND tenant_id = zea_current_tenant_id())
      );

    DROP TABLE IF EXISTS password_reset_tokens;
    DROP TABLE IF EXISTS auth_sessions;
    DROP TABLE IF EXISTS tenant_memberships;
    DROP TABLE IF EXISTS users;

    DROP FUNCTION IF EXISTS zea_can_manage_users();
    DROP FUNCTION IF EXISTS zea_is_auth_service();
    DROP FUNCTION IF EXISTS zea_current_user_id();

    DROP TYPE IF EXISTS membership_status;
    DROP TYPE IF EXISTS membership_role;
    DROP TYPE IF EXISTS platform_role;
    DROP TYPE IF EXISTS user_status;
  `);
}
