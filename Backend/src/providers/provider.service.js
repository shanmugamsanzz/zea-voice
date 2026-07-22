import crypto from 'node:crypto';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    || `provider-${crypto.randomBytes(4).toString('hex')}`;
}

function mapProvider(row) {
  const parameters = (row.parameter_keys ?? []).map((parameter) => ({
    key: parameter.key,
    value: parameter.isSecret ? decryptCredential(parameter.encryptedValue) : parameter.plainValue,
    isSecret: false,
  }));
  return {
    id: row.id, name: row.name, slug: row.slug, type: row.type, status: row.status,
    baseUrl: row.base_url, latencyMs: row.latency_ms, usageCount: Number(row.usage_count),
    parameterKeys: parameters, parameters, modelCount: Number(row.model_count ?? 0),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapModel(row) {
  const settings = { ...(row.provider_settings ?? {}), ...(row.settings ?? {}) };
  return {
    id: row.id, providerId: row.provider_id, providerName: row.provider_name,
    providerType: row.provider_type, modelKey: row.model_key, displayName: row.display_name,
    status: row.status, capabilities: row.capabilities, settings,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const providerSelect = `
  SELECT p.*,
    COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'key', x.key, 'isSecret', x.is_secret,
                'plainValue', x.plain_value, 'encryptedValue', x.encrypted_value
              ) ORDER BY x.key)
              FROM ai_provider_parameters x WHERE x.provider_id = p.id), '[]'::jsonb) AS parameter_keys,
    (SELECT count(*) FROM provider_models m WHERE m.provider_id = p.id AND m.deleted_at IS NULL) AS model_count
  FROM ai_providers p WHERE p.deleted_at IS NULL`;

async function providerRow(client, id) {
  const result = await client.query(`${providerSelect} AND p.id = $1`, [id]);
  if (!result.rowCount) throw new AppError(404, 'Provider was not found', 'PROVIDER_NOT_FOUND');
  return result.rows[0];
}

export async function createProvider(actorUserId, input) {
  const keys = input.parameters.map((item) => item.key.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new AppError(400, 'Provider parameter keys must be unique', 'DUPLICATE_PARAMETER_KEY');
  try {
    return await withPlatformAdminContext(actorUserId, async (client) => {
      const provider = (await client.query(
        `INSERT INTO ai_providers (name, slug, type, status, base_url, latency_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [input.name, slugify(input.name), input.type, input.status, input.baseUrl, input.latencyMs, actorUserId],
      )).rows[0];
      for (const parameter of input.parameters) {
        await client.query(
          `INSERT INTO ai_provider_parameters
            (provider_id, key, plain_value, encrypted_value, is_secret)
           VALUES ($1, $2, $3, $4, $5)`,
          [provider.id, parameter.key, parameter.value, null, false],
        );
      }
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1, 'user', 'AI_PROVIDER_CREATED', 'ai_provider', $2, $3::jsonb)`,
        [actorUserId, provider.id, JSON.stringify({ name: input.name, type: input.type, parameterKeys: input.parameters.map((p) => p.key) })],
      );
      return mapProvider(await providerRow(client, provider.id));
    });
  } catch (error) {
    if (error.code === '23505') throw new AppError(409, 'Provider name already exists', 'PROVIDER_EXISTS');
    throw error;
  }
}

export function listProviders(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      `${providerSelect}
       AND ($1::ai_provider_type IS NULL OR p.type = $1)
       AND ($2::provider_connection_status IS NULL OR p.status = $2)
       AND ($3::text IS NULL OR p.name ILIKE '%' || $3 || '%')
       ORDER BY p.created_at DESC`,
      [filters.type ?? null, filters.status ?? null, filters.search ?? null],
    );
    return result.rows.map(mapProvider);
  });
}

export function updateProviderStatus(actorUserId, providerId, status) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      'UPDATE ai_providers SET status = $2 WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [providerId, status],
    );
    if (!result.rowCount) throw new AppError(404, 'Provider was not found', 'PROVIDER_NOT_FOUND');
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
       VALUES ($1, 'user', 'AI_PROVIDER_STATUS_CHANGED', 'ai_provider', $2, $3::jsonb)`,
      [actorUserId, providerId, JSON.stringify({ status })],
    );
    return mapProvider(await providerRow(client, providerId));
  });
}

export function updateProvider(actorUserId, providerId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = mapProvider(await providerRow(client, providerId));
    const fields = { name: 'name', status: 'status', baseUrl: 'base_url', latencyMs: 'latency_ms' };
    const entries = Object.entries(fields).filter(([key]) => key in input);
    const values = entries.map(([key]) => input[key]);
    const sets = entries.map(([, column], index) => `${column} = $${index + 2}`);
    if (entries.length > 0) {
      try {
        await client.query(
          `UPDATE ai_providers SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL`,
          [providerId, ...values],
        );
      } catch (error) {
        if (error.code === '23505') throw new AppError(409, 'Provider name already exists', 'PROVIDER_EXISTS');
        throw error;
      }
    }
    if (input.parameters !== undefined) {
      const normalizedKeys = input.parameters.map((parameter) => parameter.key.toLowerCase());
      if (new Set(normalizedKeys).size !== normalizedKeys.length) {
        throw new AppError(400, 'Provider parameter keys must be unique', 'DUPLICATE_PARAMETER_KEY');
      }
      const storedRows = (await client.query(
        `SELECT key, plain_value, encrypted_value, is_secret
         FROM ai_provider_parameters WHERE provider_id = $1`,
        [providerId],
      )).rows;
      const stored = new Map(storedRows.map((row) => [row.key.toLowerCase(), row]));
      const replacements = input.parameters.map((parameter) => {
        if (parameter.value !== undefined) {
          return {
            key: parameter.key,
            isSecret: false,
            plainValue: parameter.value,
            encryptedValue: null,
          };
        }
        const original = stored.get((parameter.originalKey ?? parameter.key).toLowerCase());
        if (!original) {
          throw new AppError(400, `A value is required for new parameter ${parameter.key}`, 'PARAMETER_VALUE_REQUIRED');
        }
        return {
          key: parameter.key,
          isSecret: false,
          plainValue: original.is_secret ? decryptCredential(original.encrypted_value) : original.plain_value,
          encryptedValue: null,
        };
      });
      await client.query('DELETE FROM ai_provider_parameters WHERE provider_id = $1', [providerId]);
      for (const parameter of replacements) {
        await client.query(
          `INSERT INTO ai_provider_parameters
            (provider_id, key, plain_value, encrypted_value, is_secret)
           VALUES ($1, $2, $3, $4, $5)`,
          [providerId, parameter.key, parameter.plainValue, parameter.encryptedValue, parameter.isSecret],
        );
      }
    }
    const after = mapProvider(await providerRow(client, providerId));
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'user', 'AI_PROVIDER_UPDATED', 'ai_provider', $2, $3::jsonb, $4::jsonb)`,
      [actorUserId, providerId, JSON.stringify(before), JSON.stringify(after)],
    );
    return after;
  });
}

export function deleteProvider(actorUserId, providerId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = mapProvider(await providerRow(client, providerId));
    const activeAgents = await client.query(
      `SELECT count(*)::int AS count
       FROM voice_agents a
       WHERE a.deleted_at IS NULL AND a.status <> 'archived'
         AND (a.stt_model_id IN (SELECT id FROM provider_models WHERE provider_id = $1)
           OR a.llm_model_id IN (SELECT id FROM provider_models WHERE provider_id = $1)
           OR a.tts_model_id IN (SELECT id FROM provider_models WHERE provider_id = $1))`,
      [providerId],
    );
    if (activeAgents.rows[0].count > 0) {
      throw new AppError(
        409,
        'Provider cannot be deleted while its models are assigned to active agents',
        'PROVIDER_IN_USE',
        { activeAgents: activeAgents.rows[0].count },
      );
    }
    await client.query(
      `UPDATE provider_models SET status = 'inactive', deleted_at = COALESCE(deleted_at, now())
       WHERE provider_id = $1 AND deleted_at IS NULL`,
      [providerId],
    );
    await client.query(
      `UPDATE ai_providers SET status = 'disconnected', deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [providerId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'user', 'AI_PROVIDER_DELETED', 'ai_provider', $2, $3::jsonb, $4::jsonb)`,
      [actorUserId, providerId, JSON.stringify(before), JSON.stringify({ deleted: true })],
    );
    return { id: providerId, deleted: true };
  });
}

export function createProviderModel(actorUserId, providerId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    await providerRow(client, providerId);
    try {
      const result = await client.query(
        `INSERT INTO provider_models
          (provider_id, model_key, display_name, status, capabilities, settings, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING *, NULL::text AS provider_name, NULL::ai_provider_type AS provider_type`,
        [providerId, input.modelKey, input.displayName, input.status,
          JSON.stringify(input.capabilities), JSON.stringify(input.settings), actorUserId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1, 'user', 'PROVIDER_MODEL_CREATED', 'provider_model', $2, $3::jsonb)`,
        [actorUserId, result.rows[0].id, JSON.stringify({ providerId, modelKey: input.modelKey })],
      );
      return mapModel(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'This model already exists for the provider', 'PROVIDER_MODEL_EXISTS');
      throw error;
    }
  });
}

export function listProviderModels(actorUserId, providerId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    await providerRow(client, providerId);
    const result = await client.query(
      `SELECT m.*, p.name AS provider_name, p.type AS provider_type
       FROM provider_models m JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.provider_id = $1 AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC`,
      [providerId],
    );
    return result.rows.map(mapModel);
  });
}

export function updateModelStatus(actorUserId, modelId, status) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      `UPDATE provider_models SET status = $2
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [modelId, status],
    );
    if (!result.rowCount) throw new AppError(404, 'Provider model was not found', 'PROVIDER_MODEL_NOT_FOUND');
    return mapModel(result.rows[0]);
  });
}

export function updateProviderModel(actorUserId, modelId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const before = await client.query(
      `SELECT * FROM provider_models WHERE id = $1 AND deleted_at IS NULL`,
      [modelId],
    );
    if (!before.rowCount) throw new AppError(404, 'Provider model was not found', 'PROVIDER_MODEL_NOT_FOUND');
    const current = before.rows[0];
    try {
      const result = await client.query(
        `UPDATE provider_models
            SET model_key = $2, display_name = $3, status = $4,
                capabilities = $5::jsonb, settings = $6::jsonb
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING *, NULL::text AS provider_name, NULL::ai_provider_type AS provider_type`,
        [
          modelId,
          input.modelKey ?? current.model_key,
          input.displayName ?? current.display_name,
          input.status ?? current.status,
          JSON.stringify(input.capabilities ?? current.capabilities ?? {}),
          JSON.stringify(input.settings ?? current.settings ?? {}),
        ],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
         VALUES ($1, 'user', 'PROVIDER_MODEL_UPDATED', 'provider_model', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId, modelId,
          JSON.stringify({ modelKey: current.model_key, displayName: current.display_name, status: current.status }),
          JSON.stringify({
            modelKey: result.rows[0].model_key,
            displayName: result.rows[0].display_name,
            status: result.rows[0].status,
          })],
      );
      return mapModel(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'This model already exists for the provider', 'PROVIDER_MODEL_EXISTS');
      throw error;
    }
  });
}

export function getProviderCatalog(auth, type) {
  return withPlatformAdminContext(auth.userId, async (client) => {
    const result = await client.query(
      `SELECT m.*, p.name AS provider_name, p.type AS provider_type,
          COALESCE((SELECT jsonb_object_agg(x.key, x.plain_value)
            FROM ai_provider_parameters x
            WHERE x.provider_id=p.id AND x.plain_value IS NOT NULL
              AND x.is_secret=false
              AND lower(x.key) !~ '(api[_.-]?key|token|secret|password|credential|auth)'), '{}'::jsonb) AS provider_settings
       FROM provider_models m JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.status = 'active' AND m.deleted_at IS NULL
         AND p.status = 'connected' AND p.deleted_at IS NULL
         AND ($1::ai_provider_type IS NULL OR p.type = $1)
       ORDER BY p.name, m.display_name`,
      [type ?? null],
    );
    return result.rows.map(mapModel);
  });
}
