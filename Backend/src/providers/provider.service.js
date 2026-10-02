import crypto from 'node:crypto';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential } from '../security/credential-crypto.js';
import {
  defaultRuntimeConnectionType,
  bindRuntimeConnectionToCapabilities,
  isRuntimeConnectionTypeForProvider,
  providerRuntimeConnectionTypes,
  runtimeConnectionMetadata,
  runtimeConnectionStatus,
  isRuntimeConnectionLiveEligible,
} from './runtime-connection-types.js';

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
    runtimeConnectionType: row.runtime_connection_type,
    runtimeConnection: runtimeConnectionMetadata(row.type, row.runtime_connection_type),
    baseUrl: row.base_url, latencyMs: row.latency_ms, usageCount: Number(row.usage_count),
    parameterKeys: parameters, parameters, modelCount: Number(row.model_count ?? 0),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function resolvedRuntimeConnectionType(type, requestedType) {
  const runtimeConnectionType = requestedType ?? defaultRuntimeConnectionType(type);
  if (!runtimeConnectionType || !isRuntimeConnectionTypeForProvider(type, runtimeConnectionType)) {
    throw new AppError(
      400,
      'Runtime Connection Type is not supported for this Provider Type',
      'INVALID_PROVIDER_RUNTIME_CONNECTION_TYPE',
      { type, runtimeConnectionType, supported: providerRuntimeConnectionTypes[type] ?? [] },
    );
  }
  return runtimeConnectionType;
}

function mapModel(row) {
  const settings = { ...(row.provider_settings ?? {}), ...(row.settings ?? {}) };
  const runtimeConnection = runtimeConnectionMetadata(row.provider_type, row.runtime_connection_type);
  return {
    id: row.id, providerId: row.provider_id, providerName: row.provider_name,
    providerType: row.provider_type, modelKey: row.model_key, displayName: row.display_name,
    status: row.status, capabilities: row.capabilities, settings,
    runtimeConnectionType: row.runtime_connection_type ?? null,
    runtimeConnection,
    runtimeStatus: runtimeConnectionStatus(row.provider_type, row.runtime_connection_type, row.provider_status),
    providerConnectionStatus: row.provider_status ?? null,
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

const providerModelSelect = `
  SELECT m.*, p.name AS provider_name, p.type AS provider_type,
    p.runtime_connection_type, p.status AS provider_status
  FROM provider_models m JOIN ai_providers p ON p.id = m.provider_id
  WHERE m.deleted_at IS NULL`;

async function providerModelRow(client, id) {
  const result = await client.query(`${providerModelSelect} AND m.id = $1`, [id]);
  if (!result.rowCount) throw new AppError(404, 'Provider model was not found', 'PROVIDER_MODEL_NOT_FOUND');
  return result.rows[0];
}

function runtimeBoundCapabilities(provider, capabilities) {
  return bindRuntimeConnectionToCapabilities(
    provider.type,
    provider.runtimeConnectionType,
    capabilities ?? {},
  );
}

function normalizedModelSettings(input, current = {}) {
  const settings = { ...(current ?? {}), ...(input.settings ?? {}) };
  if (input.voiceId !== undefined) settings.voiceId = input.voiceId;
  if (input.language !== undefined) settings.language = input.language;
  return settings;
}

async function synchronizeProviderModelRuntimeCapabilities(client, provider) {
  const models = await client.query(
    `SELECT id, capabilities FROM provider_models WHERE provider_id = $1 AND deleted_at IS NULL`,
    [provider.id],
  );
  for (const model of models.rows) {
    await client.query(
      `UPDATE provider_models SET capabilities = $2::jsonb WHERE id = $1`,
      [model.id, JSON.stringify(runtimeBoundCapabilities(provider, model.capabilities))],
    );
  }
}

export async function createProvider(actorUserId, input) {
  const keys = input.parameters.map((item) => item.key.toLowerCase());
  if (new Set(keys).size !== keys.length) throw new AppError(400, 'Provider parameter keys must be unique', 'DUPLICATE_PARAMETER_KEY');
  try {
    return await withPlatformAdminContext(actorUserId, async (client) => {
      const runtimeConnectionType = resolvedRuntimeConnectionType(input.type, input.runtimeConnectionType);
      const provider = (await client.query(
        `INSERT INTO ai_providers (name, slug, type, runtime_connection_type, status, base_url, latency_ms, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.name, slugify(input.name), input.type, runtimeConnectionType, input.status, input.baseUrl, input.latencyMs, actorUserId],
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
        [actorUserId, provider.id, JSON.stringify({ name: input.name, type: input.type, runtimeConnectionType, parameterKeys: input.parameters.map((p) => p.key) })],
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
    if (input.runtimeConnectionType !== undefined) {
      input.runtimeConnectionType = resolvedRuntimeConnectionType(before.type, input.runtimeConnectionType);
    }
    const fields = {
      name: 'name', status: 'status', baseUrl: 'base_url', latencyMs: 'latency_ms',
      runtimeConnectionType: 'runtime_connection_type',
    };
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
    if (input.runtimeConnectionType !== undefined) {
      await synchronizeProviderModelRuntimeCapabilities(client, {
        id: before.id,
        type: before.type,
        runtimeConnectionType: input.runtimeConnectionType,
      });
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

export function listRuntimeConnectionTypes() {
  return providerRuntimeConnectionTypes;
}

export function ensurePlivoPricingProvider(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    // Serialize setup so simultaneous pricing visits cannot create duplicates.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('plivo-pricing-provider'))");
    const account = await client.query(`SELECT id FROM telephony_accounts
      WHERE provider='plivo' AND account_type='main' AND status='connected'
      AND deleted_at IS NULL LIMIT 1`);
    if (!account.rowCount) throw new AppError(400,
      'Connect a Plivo telephony account before assigning telephony prices.', 'PLIVO_ACCOUNT_REQUIRED');
    let provider = await client.query(`SELECT id FROM ai_providers
      WHERE type='telephony' AND runtime_connection_type='plivo' AND deleted_at IS NULL
      ORDER BY created_at LIMIT 1`);
    if (!provider.rowCount) provider = await client.query(`INSERT INTO ai_providers
      (name,slug,type,runtime_connection_type,status,created_by)
      VALUES ($1,$2,'telephony','plivo','connected',$3) RETURNING id`,
    ['Plivo Telephony Pricing', `plivo-pricing-${crypto.randomUUID()}`, actorUserId]);
    const providerId = provider.rows[0].id;
    const models = await client.query(`SELECT id FROM provider_models
      WHERE provider_id=$1 AND deleted_at IS NULL LIMIT 1`, [providerId]);
    if (!models.rowCount) await client.query(`INSERT INTO provider_models
      (provider_id,model_key,display_name,status,capabilities,settings,created_by)
      VALUES ($1,'plivo-voice','Plivo Voice Calls','active','{}'::jsonb,'{}'::jsonb,$2)`,
    [providerId, actorUserId]);
    return mapProvider(await providerRow(client, providerId));
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
    const provider = mapProvider(await providerRow(client, providerId));
    const modelStatus = isRuntimeConnectionLiveEligible(
      provider.type, provider.runtimeConnectionType, provider.status,
    ) ? input.status : 'inactive';
    try {
      const result = await client.query(
        `INSERT INTO provider_models
          (provider_id, model_key, display_name, status, capabilities, settings, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING id`,
        [providerId, input.modelKey, input.displayName, modelStatus,
          JSON.stringify(runtimeBoundCapabilities(provider, input.capabilities)),
          JSON.stringify(normalizedModelSettings(input)), actorUserId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1, 'user', 'PROVIDER_MODEL_CREATED', 'provider_model', $2, $3::jsonb)`,
        [actorUserId, result.rows[0].id, JSON.stringify({ providerId, modelKey: input.modelKey })],
      );
      return mapModel(await providerModelRow(client, result.rows[0].id));
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
      `${providerModelSelect} AND m.provider_id = $1
       ORDER BY m.created_at DESC`,
      [providerId],
    );
    return result.rows.map(mapModel);
  });
}

function mapModelPrice(row) {
  return {
    id: row.id, providerId: row.provider_id, modelId: row.model_id,
    parameterName: row.parameter_name, currency: row.currency, unitName: row.unit_name,
    unitQuantity: Number(row.unit_quantity), price: Number(row.price),
    effectiveDate: row.effective_date, status: row.status, notes: row.notes,
    createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function providerModelPriceRow(client, id) {
  const result = await client.query(
    `SELECT price.*
       FROM provider_model_prices price
       JOIN provider_models model ON model.id = price.model_id
      WHERE price.id = $1 AND model.deleted_at IS NULL`,
    [id],
  );
  if (!result.rowCount) throw new AppError(404, 'Provider model price was not found', 'PROVIDER_MODEL_PRICE_NOT_FOUND');
  return result.rows[0];
}

export function createProviderModelPrices(actorUserId, modelId, input, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withPlatformAdminContext;
  return contextRunner(actorUserId, async (client) => {
    try {
      const model = await providerModelRow(client, modelId);
      if (model.provider_id !== input.providerId) {
        throw new AppError(400, 'The selected model does not belong to the selected provider', 'MODEL_PROVIDER_MISMATCH');
      }
      const created = [];
      for (const parameter of input.parameters) {
        const result = await client.query(
          `INSERT INTO provider_model_prices
            (provider_id, model_id, parameter_name, currency, unit_name, unit_quantity,
             price, effective_date, status, notes, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::date, CURRENT_DATE), $9, $10, $11, $11)
           RETURNING *`,
          [model.provider_id, modelId, parameter.parameterName, parameter.currency, parameter.unitName,
            parameter.unitQuantity, parameter.price, parameter.effectiveDate ?? null, parameter.status,
            parameter.notes ?? null, actorUserId],
        );
        created.push(mapModelPrice(result.rows[0]));
      }
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1, 'user', 'PROVIDER_MODEL_PRICES_CREATED', 'provider_model', $2, $3::jsonb)`,
        [actorUserId, modelId, JSON.stringify({
          providerId: model.provider_id,
          parameters: created.map((price) => ({ parameterName: price.parameterName, unitName: price.unitName, unitQuantity: price.unitQuantity })),
        })],
      );
      return created;
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'An active price already exists for this model, parameter, and effective date', 'ACTIVE_PRICE_PERIOD_EXISTS');
      }
      throw error;
    }
  });
}

export function listProviderModelPrices(actorUserId, modelId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    await providerModelRow(client, modelId);
    const result = await client.query(
      `SELECT * FROM provider_model_prices
        WHERE model_id = $1
        ORDER BY parameter_name ASC, effective_date DESC, updated_at DESC`,
      [modelId],
    );
    return result.rows.map(mapModelPrice);
  });
}

export function listProviderModelPriceHistory(actorUserId, modelId, parameterName) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    await providerModelRow(client, modelId);
    const result = await client.query(
      `SELECT * FROM provider_model_prices
        WHERE model_id = $1 AND lower(parameter_name) = lower($2)
        ORDER BY effective_date DESC, updated_at DESC`,
      [modelId, parameterName],
    );
    return result.rows.map(mapModelPrice);
  });
}

export function updateProviderModelPrice(actorUserId, priceId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    try {
      const current = await providerModelPriceRow(client, priceId);
      const next = {
        parameterName: input.parameterName ?? current.parameter_name,
        currency: input.currency ?? current.currency,
        unitName: input.unitName ?? current.unit_name,
        unitQuantity: input.unitQuantity ?? current.unit_quantity,
        price: input.price ?? current.price,
        effectiveDate: input.effectiveDate ?? current.effective_date,
        status: input.status ?? current.status,
        notes: input.notes !== undefined ? input.notes : current.notes,
      };
      if (next.status === 'active') {
        await client.query(
          `UPDATE provider_model_prices
            SET status = 'inactive', updated_by = $4
          WHERE model_id = $1 AND lower(parameter_name) = lower($2)
            AND effective_date = $3::date AND status = 'active'`,
          [current.model_id, next.parameterName, next.effectiveDate, actorUserId],
        );
      }
      const result = await client.query(
        `INSERT INTO provider_model_prices
        (provider_id, model_id, parameter_name, currency, unit_name, unit_quantity,
         price, effective_date, status, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11, $11)
       RETURNING *`,
        [current.provider_id, current.model_id, next.parameterName, next.currency, next.unitName,
          next.unitQuantity, next.price, next.effectiveDate, next.status, next.notes, actorUserId],
      );
      const updated = mapModelPrice(result.rows[0]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'user', 'PROVIDER_MODEL_PRICE_VERSION_CREATED', 'provider_model_price', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId, updated.id, JSON.stringify(mapModelPrice(current)), JSON.stringify(updated)],
      );
      return updated;
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'An active price already exists for this model, parameter, and effective date', 'ACTIVE_PRICE_PERIOD_EXISTS');
      }
      throw error;
    }
  });
}

export function updateProviderModelPriceStatus(actorUserId, priceId, status) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    try {
      const current = await providerModelPriceRow(client, priceId);
      const result = await client.query(
        `UPDATE provider_model_prices SET status = $2, updated_by = $3 WHERE id = $1 RETURNING *`,
        [priceId, status, actorUserId],
      );
      const updated = mapModelPrice(result.rows[0]);
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'user', 'PROVIDER_MODEL_PRICE_STATUS_CHANGED', 'provider_model_price', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId, priceId, JSON.stringify({ status: current.status }), JSON.stringify({ status: updated.status })],
      );
      return updated;
    } catch (error) {
      if (error.code === '23505') {
        throw new AppError(409, 'Deactivate the current active price for this effective period before activating this history row', 'ACTIVE_PRICE_PERIOD_EXISTS');
      }
      throw error;
    }
  });
}

export function updateModelStatus(actorUserId, modelId, status) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const current = await providerModelRow(client, modelId);
    if (status === 'active' && !isRuntimeConnectionLiveEligible(
      current.provider_type, current.runtime_connection_type, current.provider_status,
    )) {
      throw new AppError(409, 'Configuration-only models cannot be activated for live agents', 'MODEL_CONFIGURATION_ONLY');
    }
    const result = await client.query(
      `UPDATE provider_models SET status = $2
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [modelId, status],
    );
    if (!result.rowCount) throw new AppError(404, 'Provider model was not found', 'PROVIDER_MODEL_NOT_FOUND');
    return mapModel(await providerModelRow(client, result.rows[0].id));
  });
}

export function updateProviderModel(actorUserId, modelId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const current = await providerModelRow(client, modelId);
    const provider = {
      id: current.provider_id,
      type: current.provider_type,
      runtimeConnectionType: current.runtime_connection_type,
    };
    if (input.status === 'active' && !isRuntimeConnectionLiveEligible(
      provider.type, provider.runtimeConnectionType, current.provider_status,
    )) {
      throw new AppError(409, 'Configuration-only models cannot be activated for live agents', 'MODEL_CONFIGURATION_ONLY');
    }
    try {
      const result = await client.query(
        `UPDATE provider_models
            SET model_key = $2, display_name = $3, status = $4,
                capabilities = $5::jsonb, settings = $6::jsonb
          WHERE id = $1 AND deleted_at IS NULL
          RETURNING id`,
        [
          modelId,
          input.modelKey ?? current.model_key,
          input.displayName ?? current.display_name,
          input.status ?? current.status,
          JSON.stringify(runtimeBoundCapabilities(provider, input.capabilities ?? current.capabilities ?? {})),
          JSON.stringify(normalizedModelSettings(input, current.settings)),
        ],
      );
      const after = mapModel(await providerModelRow(client, result.rows[0].id));
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
         VALUES ($1, 'user', 'PROVIDER_MODEL_UPDATED', 'provider_model', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId, modelId,
          JSON.stringify({ modelKey: current.model_key, displayName: current.display_name, status: current.status }),
          JSON.stringify({
            modelKey: after.modelKey,
            displayName: after.displayName,
            status: after.status,
          })],
      );
      return after;
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
          p.runtime_connection_type, p.status AS provider_status,
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
    return result.rows.map(mapModel).filter((model) => model.runtimeStatus === 'runtime_supported');
  });
}
