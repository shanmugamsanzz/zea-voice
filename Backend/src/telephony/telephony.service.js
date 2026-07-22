import { env } from '../config/env.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { decryptCredential, encryptCredential } from '../security/credential-crypto.js';
import {
  createPlivoApplication, createPlivoSubaccount, deletePlivoSubaccount,
  listPlivoNumbers, updatePlivoNumber,
} from './plivo.client.js';

function readTelephonyCredential(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(500, 'Stored credential is invalid', 'INVALID_STORED_CREDENTIAL');
  }
  return value.startsWith('v1.') ? decryptCredential(value) : value;
}

async function upgradeLegacyCredentials(client, rows) {
  for (const row of rows) {
    if (typeof row.auth_token_encrypted === 'string' && !row.auth_token_encrypted.startsWith('v1.')) {
      row.auth_token_encrypted = encryptCredential(row.auth_token_encrypted);
      await client.query(
        `UPDATE telephony_accounts SET auth_token_encrypted = $2
         WHERE id = $1 AND auth_token_encrypted NOT LIKE 'v1.%'`,
        [row.id, row.auth_token_encrypted],
      );
    }
  }
  return rows;
}

function mapAccount(row) {
  return {
    id: row.id, provider: row.provider, name: row.name, authId: row.auth_id,
    authToken: readTelephonyCredential(row.auth_token_encrypted),
    authTokenConfigured: Boolean(row.auth_token_encrypted), baseUrl: row.base_url,
    applicationId: row.application_id, answerUrl: row.answer_url, hangupUrl: row.hangup_url,
    recordingCallbackUrl: row.recording_callback_url, status: row.status,
    accountType: row.account_type, parentAccountId: row.parent_account_id,
    companyId: row.tenant_id, providerSubaccountId: row.provider_subaccount_id,
    lastSyncedAt: row.last_synced_at, syncError: row.sync_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapAccountAudit(row) {
  return {
    id: row.id, provider: row.provider, name: row.name, authId: row.auth_id,
    authTokenConfigured: Boolean(row.auth_token_encrypted), baseUrl: row.base_url,
    applicationId: row.application_id, answerUrl: row.answer_url, hangupUrl: row.hangup_url,
    recordingCallbackUrl: row.recording_callback_url, status: row.status,
    accountType: row.account_type, parentAccountId: row.parent_account_id,
    companyId: row.tenant_id, providerSubaccountId: row.provider_subaccount_id,
  };
}

function mapPhone(row) {
  return {
    id: row.id, number: row.e164, provider: row.provider, telephonyAccountId: row.telephony_account_id,
    telephonyAccountName: row.telephony_account_name, accountType: row.account_type,
    subaccountAuthId: row.provider_subaccount_id,
    countryIso: row.country_iso, numberType: row.number_type, capabilities: row.capabilities,
    monthlyCost: row.monthly_cost === null ? null : Number(row.monthly_cost), currency: row.currency,
    status: row.status, companyId: row.tenant_id, companyName: row.company_name,
    assignedAt: row.assigned_at, lastSyncedAt: row.last_synced_at,
  };
}

const phoneSelect = `
  SELECT count(*) OVER()::int AS full_count,
         n.*, a.provider, a.name AS telephony_account_name, a.account_type, a.provider_subaccount_id,
         x.tenant_id, t.name AS company_name, x.assigned_at
  FROM phone_numbers n
  JOIN telephony_accounts a ON a.id = n.telephony_account_id
  LEFT JOIN phone_number_assignments x ON x.phone_number_id = n.id AND x.released_at IS NULL
  LEFT JOIN tenants t ON t.id = x.tenant_id
  WHERE n.deleted_at IS NULL`;

export async function createTelephonyAccount(actorUserId, input) {
  const encryptedToken = encryptCredential(input.authToken);
  try {
    return await withPlatformAdminContext(actorUserId, async (client) => {
      const result = await client.query(
        `INSERT INTO telephony_accounts
          (provider, name, auth_id, auth_token_encrypted, base_url, application_id,
           answer_url, hangup_url, recording_callback_url, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [input.provider, input.name, input.authId, encryptedToken, input.baseUrl, input.applicationId,
          input.answerUrl, input.hangupUrl, input.recordingCallbackUrl, input.status, actorUserId],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1, 'user', 'TELEPHONY_ACCOUNT_CREATED', 'telephony_account', $2, $3::jsonb)`,
        [actorUserId, result.rows[0].id, JSON.stringify({ provider: input.provider, name: input.name, authId: input.authId })],
      );
      return mapAccount(result.rows[0]);
    });
  } catch (error) {
    if (error.code === '23505') throw new AppError(409, 'This telephony account already exists', 'TELEPHONY_ACCOUNT_EXISTS');
    throw error;
  }
}

export function updateTelephonyAccount(actorUserId, accountId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const beforeResult = await client.query(
      'SELECT * FROM telephony_accounts WHERE id = $1 AND deleted_at IS NULL', [accountId],
    );
    if (!beforeResult.rowCount) throw new AppError(404, 'Telephony account was not found', 'TELEPHONY_ACCOUNT_NOT_FOUND');
    const fields = {
      name: 'name', authId: 'auth_id', baseUrl: 'base_url', applicationId: 'application_id',
      answerUrl: 'answer_url', hangupUrl: 'hangup_url', recordingCallbackUrl: 'recording_callback_url',
      status: 'status',
    };
    const entries = Object.entries(fields).filter(([key]) => key in input);
    const values = entries.map(([key]) => input[key]);
    const sets = entries.map(([, column], index) => `${column} = $${index + 2}`);
    if (input.authToken !== undefined) {
      sets.push(`auth_token_encrypted = $${values.length + 2}`);
      values.push(encryptCredential(input.authToken));
    }
    try {
      const result = await client.query(
        `UPDATE telephony_accounts SET ${sets.join(', ')} WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
        [accountId, ...values],
      );
      await client.query(
        `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
         VALUES ($1, 'user', 'TELEPHONY_ACCOUNT_UPDATED', 'telephony_account', $2, $3::jsonb, $4::jsonb)`,
        [actorUserId, accountId, JSON.stringify(mapAccountAudit(beforeResult.rows[0])), JSON.stringify(mapAccountAudit(result.rows[0]))],
      );
      return mapAccount(result.rows[0]);
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'This telephony account already exists', 'TELEPHONY_ACCOUNT_EXISTS');
      throw error;
    }
  });
}

export function deleteTelephonyAccount(actorUserId, accountId, fetchImpl = fetch) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const account = await client.query(
      'SELECT * FROM telephony_accounts WHERE id = $1 AND deleted_at IS NULL', [accountId],
    );
    if (!account.rowCount) throw new AppError(404, 'Telephony account was not found', 'TELEPHONY_ACCOUNT_NOT_FOUND');
    if (account.rows[0].account_type !== 'main') {
      throw new AppError(409, 'Company subaccounts are managed through their parent provider', 'SUBACCOUNT_DELETE_NOT_ALLOWED');
    }
    const children = await client.query(
      `SELECT * FROM telephony_accounts
       WHERE parent_account_id = $1 AND account_type = 'subaccount' AND deleted_at IS NULL
       ORDER BY created_at`, [accountId],
    );
    const assigned = await client.query(
      `SELECT count(*)::int AS count FROM phone_numbers n
       JOIN phone_number_assignments a ON a.phone_number_id = n.id AND a.released_at IS NULL
       JOIN telephony_accounts ta ON ta.id = n.telephony_account_id
       WHERE (ta.id = $1 OR ta.parent_account_id = $1) AND n.deleted_at IS NULL`,
      [accountId],
    );
    if (assigned.rows[0].count > 0) {
      throw new AppError(409, 'Release assigned phone numbers before deleting this provider', 'TELEPHONY_ACCOUNT_IN_USE');
    }
    const mainToken = readTelephonyCredential(account.rows[0].auth_token_encrypted);
    for (const child of children.rows) {
      try {
        await deletePlivoSubaccount(
          account.rows[0].auth_id, mainToken, child.provider_subaccount_id || child.auth_id,
          fetchImpl, account.rows[0].base_url,
        );
      } catch (error) {
        // A previous attempt may have removed the provider resource before its
        // database transaction failed. Treat provider 404 as an idempotent delete.
        if (!(error instanceof AppError && error.code === 'PLIVO_REQUEST_FAILED'
          && error.details?.providerStatus === 404)) throw error;
      }
    }
    await client.query(
      `UPDATE phone_numbers SET status = 'released', deleted_at = COALESCE(deleted_at, now())
       WHERE telephony_account_id IN (
         SELECT id FROM telephony_accounts WHERE id = $1 OR parent_account_id = $1
       ) AND deleted_at IS NULL`, [accountId],
    );
    await client.query(
      `UPDATE telephony_accounts SET status = 'disconnected', deleted_at = now()
       WHERE parent_account_id = $1 AND account_type = 'subaccount' AND deleted_at IS NULL`,
      [accountId],
    );
    await client.query(
      `UPDATE telephony_accounts SET status = 'disconnected', deleted_at = now()
       WHERE id = $1 AND deleted_at IS NULL`, [accountId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
       VALUES ($1, 'user', 'TELEPHONY_ACCOUNT_DELETED', 'telephony_account', $2, $3::jsonb, $4::jsonb)`,
      [actorUserId, accountId, JSON.stringify(mapAccountAudit(account.rows[0])),
        JSON.stringify({ deleted: true, deletedSubaccountCount: children.rowCount })],
    );
    return { id: accountId, deleted: true };
  });
}

export function listTelephonyAccounts(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query("SELECT * FROM telephony_accounts WHERE account_type = 'main' AND deleted_at IS NULL ORDER BY created_at DESC");
    await upgradeLegacyCredentials(client, result.rows);
    return result.rows.map(mapAccount);
  });
}

export function listCompanySubaccounts(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(`
      SELECT a.*, t.name AS company_name, p.name AS parent_account_name,
        count(n.id) FILTER (WHERE n.deleted_at IS NULL)::int AS phone_numbers_count
      FROM telephony_accounts a
      JOIN tenants t ON t.id = a.tenant_id
      JOIN telephony_accounts p ON p.id = a.parent_account_id
      LEFT JOIN phone_numbers n ON n.telephony_account_id = a.id
      WHERE a.account_type = 'subaccount' AND a.deleted_at IS NULL
      GROUP BY a.id, t.name, p.name ORDER BY t.name, a.created_at`);
    await upgradeLegacyCredentials(client, result.rows);
    return result.rows.map((row) => ({
      ...mapAccount(row), companyName: row.company_name,
      parentAccountName: row.parent_account_name, phoneNumbersCount: row.phone_numbers_count,
    }));
  });
}

function normalizeNumber(value) {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

function remoteSubaccountAuthId(item) {
  const value = item.sub_account ?? item.subaccount ?? null;
  if (!value) return null;
  const match = String(value).match(/SA[A-Za-z0-9]+/);
  return match?.[0] ?? String(value);
}

function plivoCapabilities(item) {
  const enabled = (value) => value === true || value === 'true';
  return {
    voice: enabled(item.voice_enabled), sms: enabled(item.sms_enabled), mms: enabled(item.mms_enabled),
  };
}

export async function syncTelephonyAccount(actorUserId, accountId, fetchImpl = fetch) {
  const account = await withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      'SELECT * FROM telephony_accounts WHERE id = $1 AND deleted_at IS NULL', [accountId],
    );
    if (!result.rowCount) throw new AppError(404, 'Telephony account was not found', 'TELEPHONY_ACCOUNT_NOT_FOUND');
    return result.rows[0];
  });
  if (account.provider !== 'plivo') throw new AppError(400, 'Unsupported telephony provider', 'UNSUPPORTED_TELEPHONY_PROVIDER');

  let remoteNumbers;
  try {
    remoteNumbers = await listPlivoNumbers(
      account.auth_id, readTelephonyCredential(account.auth_token_encrypted), fetchImpl, account.base_url,
    );
  } catch (error) {
    await withPlatformAdminContext(actorUserId, (client) => client.query(
      `UPDATE telephony_accounts SET status = 'error', sync_error = $2 WHERE id = $1`,
      [accountId, error.message],
    ));
    throw error;
  }

  return withPlatformAdminContext(actorUserId, async (client) => {
    const childAccounts = account.account_type === 'main'
      ? await client.query(`SELECT id, auth_id FROM telephony_accounts
          WHERE parent_account_id = $1 AND account_type = 'subaccount' AND deleted_at IS NULL`, [accountId])
      : { rows: [] };
    const childrenByAuthId = new Map(childAccounts.rows.map((row) => [row.auth_id, row.id]));
    const synced = [];
    for (const item of remoteNumbers) {
      const e164 = normalizeNumber(item.number);
      if (!e164) continue;
      const remoteSubaccount = remoteSubaccountAuthId(item);
      const owningAccountId = account.account_type === 'subaccount'
        ? account.id : (childrenByAuthId.get(remoteSubaccount) ?? account.id);
      const result = await client.query(
        `INSERT INTO phone_numbers
          (telephony_account_id, e164, provider_number_id, country_iso, number_type,
           capabilities, status, provider_data, last_synced_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'active', $7::jsonb, now())
         ON CONFLICT (e164) DO UPDATE SET
           telephony_account_id = EXCLUDED.telephony_account_id,
           provider_number_id = EXCLUDED.provider_number_id,
           country_iso = EXCLUDED.country_iso,
           number_type = EXCLUDED.number_type,
           capabilities = EXCLUDED.capabilities,
           status = 'active', provider_data = EXCLUDED.provider_data,
           last_synced_at = now(), deleted_at = NULL
         RETURNING id`,
        [owningAccountId, e164, item.number, item.country_iso?.toUpperCase() ?? null,
          item.type ?? null, JSON.stringify(plivoCapabilities(item)), JSON.stringify(item)],
      );
      synced.push(result.rows[0].id);
    }
    await client.query(
      `UPDATE phone_numbers SET status = 'unavailable'
       WHERE telephony_account_id = $1 AND deleted_at IS NULL
         AND NOT (id = ANY($2::uuid[]))`,
      [accountId, synced],
    );
    await client.query(
      `UPDATE telephony_accounts
       SET status = 'connected', last_synced_at = now(), sync_error = NULL WHERE id = $1`,
      [accountId],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
       VALUES ($1, 'user', 'PHONE_NUMBERS_SYNCED', 'telephony_account', $2, $3::jsonb)`,
      [actorUserId, accountId, JSON.stringify({ count: synced.length })],
    );
    return { accountId, synchronized: synced.length };
  });
}

export function listPhoneNumbers(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const assignmentSql = filters.assignment === 'assigned' ? 'AND x.id IS NOT NULL'
      : filters.assignment === 'unassigned' ? 'AND x.id IS NULL' : '';
    const values = [filters.search ?? null, filters.companyId ?? null, filters.status ?? null];
    const filterSql = `
      AND ($1::text IS NULL OR n.e164 ILIKE '%' || $1 || '%' OR t.name ILIKE '%' || $1 || '%')
      AND ($2::uuid IS NULL OR x.tenant_id = $2)
      AND ($3::phone_number_status IS NULL OR n.status = $3) ${assignmentSql}`;
    const offset = (filters.page - 1) * filters.pageSize;
    const result = await client.query(
      `${phoneSelect} ${filterSql} ORDER BY n.created_at DESC LIMIT $4 OFFSET $5`,
      [...values, filters.pageSize, offset],
    );
    const total = result.rows[0]?.full_count ?? 0;
    return { items: result.rows.map(mapPhone), pagination: {
      page: filters.page, pageSize: filters.pageSize, total,
      totalPages: Math.ceil(total / filters.pageSize),
    } };
  });
}

export function listAssignablePhoneOptions(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(
      `SELECT n.id, n.e164 AS number
       FROM phone_numbers n
       LEFT JOIN phone_number_assignments x
         ON x.phone_number_id = n.id AND x.released_at IS NULL
       WHERE n.deleted_at IS NULL AND n.status = 'active' AND x.id IS NULL
       ORDER BY n.e164 ASC
       LIMIT 1000`,
    );
    return result.rows;
  });
}

async function phoneRow(client, phoneNumberId) {
  const result = await client.query(`${phoneSelect} AND n.id = $1`, [phoneNumberId]);
  if (!result.rowCount) throw new AppError(404, 'Phone number was not found', 'PHONE_NUMBER_NOT_FOUND');
  return result.rows[0];
}

function plivoApplicationName(companyId) {
  return `Zea_${companyId.replace(/-/g, '').slice(0, 24)}`;
}

async function ensureCompanySubaccount(client, actorUserId, mainAccount, company, fetchImpl) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [mainAccount.id, company.id]);
  const existing = await client.query(
    `SELECT * FROM telephony_accounts
     WHERE parent_account_id = $1 AND tenant_id = $2 AND account_type = 'subaccount' AND deleted_at IS NULL`,
    [mainAccount.id, company.id],
  );
  if (existing.rowCount) return existing.rows[0];

  const mainToken = readTelephonyCredential(mainAccount.auth_token_encrypted);
  const subaccount = await createPlivoSubaccount(
    mainAccount.auth_id, mainToken, `Zea - ${company.name}`.slice(0, 160), fetchImpl, mainAccount.base_url,
  );
  if (!subaccount?.auth_id || !subaccount?.auth_token) {
    throw new AppError(502, 'Plivo did not return subaccount credentials', 'PLIVO_SUBACCOUNT_RESPONSE_INVALID');
  }

  let application;
  try {
    application = await createPlivoApplication(mainAccount.auth_id, mainToken, {
      name: plivoApplicationName(company.id), answerUrl: mainAccount.answer_url,
      hangupUrl: mainAccount.hangup_url, subaccountAuthId: subaccount.auth_id,
    }, fetchImpl, mainAccount.base_url);
    if (!application?.app_id) {
      throw new AppError(502, 'Plivo did not return an application identifier', 'PLIVO_APPLICATION_RESPONSE_INVALID');
    }
    const inserted = await client.query(
      `INSERT INTO telephony_accounts
        (provider, name, auth_id, auth_token_encrypted, base_url, application_id,
         answer_url, hangup_url, recording_callback_url, status, created_by,
         account_type, parent_account_id, tenant_id, provider_subaccount_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'connected',$10,'subaccount',$11,$12,$13,$14::jsonb)
       RETURNING *`,
      [mainAccount.provider, `Zea ${company.id.slice(0, 8)} - ${company.name}`.slice(0, 160), subaccount.auth_id,
        encryptCredential(subaccount.auth_token), mainAccount.base_url, application.app_id,
        mainAccount.answer_url, mainAccount.hangup_url, mainAccount.recording_callback_url,
        actorUserId, mainAccount.id, company.id, subaccount.auth_id,
        JSON.stringify({ subaccountApiId: subaccount.api_id ?? null, applicationApiId: application.api_id ?? null })],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
       VALUES ($1,$2,'user','TELEPHONY_SUBACCOUNT_CREATED','telephony_account',$3,$4::jsonb)`,
      [company.id, actorUserId, inserted.rows[0].id, JSON.stringify(mapAccountAudit(inserted.rows[0]))],
    );
    return inserted.rows[0];
  } catch (error) {
    await deletePlivoSubaccount(
      mainAccount.auth_id, mainToken, subaccount.auth_id, fetchImpl, mainAccount.base_url,
    ).catch(() => undefined);
    throw error;
  }
}

export function assignPhoneNumber(actorUserId, phoneNumberId, companyId, fetchImpl = fetch) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const phone = await client.query(
      `SELECT n.*, a.account_type, a.parent_account_id, a.provider_subaccount_id AS current_subaccount_id,
        a.application_id AS current_application_id,
        m.id AS main_account_id, m.auth_id AS main_auth_id, m.auth_token_encrypted AS main_token_encrypted,
        m.base_url AS main_base_url, m.provider, m.name AS main_account_name,
        m.answer_url, m.hangup_url, m.recording_callback_url, m.application_id AS main_application_id
       FROM phone_numbers n
       JOIN telephony_accounts a ON a.id = n.telephony_account_id
       JOIN telephony_accounts m ON m.id = CASE WHEN a.account_type = 'main' THEN a.id ELSE a.parent_account_id END
       WHERE n.id = $1 AND n.deleted_at IS NULL FOR UPDATE OF n`, [phoneNumberId],
    );
    if (!phone.rowCount) throw new AppError(404, 'Phone number was not found', 'PHONE_NUMBER_NOT_FOUND');
    if (phone.rows[0].status !== 'active') throw new AppError(409, 'Only active provider numbers can be assigned', 'PHONE_NUMBER_NOT_ACTIVE');
    const company = await client.query(
      `SELECT t.id, t.name, t.status, l.max_phone_numbers FROM tenants t
       JOIN tenant_limits l ON l.tenant_id = t.id
       WHERE t.id = $1 AND t.deleted_at IS NULL FOR UPDATE OF t, l`, [companyId],
    );
    if (!company.rowCount) throw new AppError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
    if (company.rows[0].status !== 'active') throw new AppError(409, 'Phone numbers can only be assigned to active companies', 'COMPANY_NOT_ACTIVE');
    const existing = await client.query(
      `SELECT id, tenant_id FROM phone_number_assignments
       WHERE phone_number_id = $1 AND released_at IS NULL FOR UPDATE`, [phoneNumberId],
    );
    if (existing.rowCount) {
      if (existing.rows[0].tenant_id === companyId) return mapPhone(await phoneRow(client, phoneNumberId));
      throw new AppError(409, 'Phone number is already assigned to another company', 'PHONE_NUMBER_ALREADY_ASSIGNED');
    }
    const assignedCount = await client.query(
      `SELECT count(*)::int AS count FROM phone_number_assignments
       WHERE tenant_id = $1 AND released_at IS NULL`, [companyId],
    );
    if (assignedCount.rows[0].count >= company.rows[0].max_phone_numbers) {
      throw new AppError(409, 'The company phone-number limit has been reached', 'COMPANY_PHONE_LIMIT_REACHED');
    }
    const mainAccount = {
      id: phone.rows[0].main_account_id, auth_id: phone.rows[0].main_auth_id,
      auth_token_encrypted: phone.rows[0].main_token_encrypted, base_url: phone.rows[0].main_base_url,
      provider: phone.rows[0].provider, name: phone.rows[0].main_account_name,
      answer_url: phone.rows[0].answer_url, hangup_url: phone.rows[0].hangup_url,
      recording_callback_url: phone.rows[0].recording_callback_url,
      application_id: phone.rows[0].main_application_id,
    };
    const subaccount = await ensureCompanySubaccount(client, actorUserId, mainAccount, company.rows[0], fetchImpl);
    const mainToken = readTelephonyCredential(mainAccount.auth_token_encrypted);
    await updatePlivoNumber(mainAccount.auth_id, mainToken, phone.rows[0].e164, {
      subaccountAuthId: subaccount.auth_id, applicationId: subaccount.application_id,
      alias: company.rows[0].name.slice(0, 64),
    }, fetchImpl, mainAccount.base_url);
    try {
      await client.query(
        `INSERT INTO phone_number_assignments (phone_number_id, tenant_id, assigned_by)
         VALUES ($1, $2, $3)`, [phoneNumberId, companyId, actorUserId],
      );
      await client.query(
        `UPDATE phone_numbers SET assigned_tenant_id = $2, telephony_account_id = $3,
          provider_data = provider_data || $4::jsonb WHERE id = $1`,
        [phoneNumberId, companyId, subaccount.id,
          JSON.stringify({ plivoSubaccountAuthId: subaccount.auth_id, plivoApplicationId: subaccount.application_id })],
      );
      await client.query(
        `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
         VALUES ($1::uuid, $2::uuid, 'user', 'PHONE_NUMBER_ASSIGNED', 'phone_number', $3::uuid::text, $4::jsonb)`,
        [companyId, actorUserId, phoneNumberId, JSON.stringify({
          companyId, subaccountId: subaccount.id, providerSubaccountId: subaccount.auth_id,
          applicationId: subaccount.application_id,
        })],
      );
    } catch (error) {
      await updatePlivoNumber(mainAccount.auth_id, mainToken, phone.rows[0].e164, {
        subaccountAuthId: phone.rows[0].current_subaccount_id ?? null,
        applicationId: phone.rows[0].current_application_id || mainAccount.application_id,
      }, fetchImpl, mainAccount.base_url).catch(() => undefined);
      throw error;
    }
    return mapPhone(await phoneRow(client, phoneNumberId));
  });
}

export function releasePhoneNumber(actorUserId, phoneNumberId, reason, fetchImpl = fetch) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const phone = await client.query(
      `SELECT n.*, a.account_type, a.parent_account_id,
        m.id AS main_account_id, m.auth_id AS main_auth_id, m.auth_token_encrypted AS main_token_encrypted,
        m.base_url AS main_base_url, m.application_id AS main_application_id
       FROM phone_numbers n
       JOIN telephony_accounts a ON a.id = n.telephony_account_id
       JOIN telephony_accounts m ON m.id = CASE WHEN a.account_type = 'main' THEN a.id ELSE a.parent_account_id END
       WHERE n.id = $1 AND n.deleted_at IS NULL FOR UPDATE OF n`, [phoneNumberId],
    );
    if (!phone.rowCount) throw new AppError(404, 'Phone number was not found', 'PHONE_NUMBER_NOT_FOUND');
    const activeAssignment = await client.query(
      `SELECT tenant_id FROM phone_number_assignments
       WHERE phone_number_id = $1 AND released_at IS NULL FOR UPDATE`, [phoneNumberId],
    );
    if (!activeAssignment.rowCount) throw new AppError(409, 'Phone number is not currently assigned', 'PHONE_NUMBER_NOT_ASSIGNED');
    // Plivo only accepts an SA... identifier in the number `subaccount` field;
    // neither null nor the parent MA... identifier moves one DID back to the main
    // account. Keep the provider ownership record so the number can later move
    // directly to another company subaccount. Zea revokes routing below by ending
    // the active assignment, which is required by the inbound agent resolver.
    const assignment = await client.query(
      `UPDATE phone_number_assignments
       SET released_at = now(), released_by = $2, release_reason = $3
       WHERE phone_number_id = $1 AND released_at IS NULL RETURNING tenant_id`,
      [phoneNumberId, actorUserId, reason ?? null],
    );
    await client.query(
      `UPDATE phone_numbers SET assigned_tenant_id = NULL,
        provider_data = provider_data - 'plivoSubaccountAuthId' - 'plivoApplicationId' WHERE id = $1`,
      [phoneNumberId],
    );
    const detachedAgents = await client.query(
      `UPDATE voice_agents SET phone_number_id = NULL, updated_at = now()
       WHERE phone_number_id = $1 AND deleted_at IS NULL RETURNING id`,
      [phoneNumberId],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
        VALUES ($1::uuid, $2::uuid, 'user', 'PHONE_NUMBER_RELEASED', 'phone_number', $3::uuid::text, $4::jsonb)`,
      [assignment.rows[0].tenant_id, actorUserId, phoneNumberId,
        JSON.stringify({ reason: reason ?? null, detachedAgentCount: detachedAgents.rowCount })],
    );
    return mapPhone(await phoneRow(client, phoneNumberId));
  });
}

export function listTenantPhoneNumbers(auth) {
  return withTenantContext(auth, async (client) => {
    const result = await client.query(
      "SELECT n.id, n.e164, n.country_iso, n.number_type, n.capabilities, n.status, "
      + "x.assigned_at, agent.id AS agent_id, agent.name AS agent_name, "
      + "agent.status AS agent_status "
      + "FROM phone_numbers n "
      + "JOIN phone_number_assignments x "
      + "ON x.phone_number_id = n.id AND x.tenant_id = $1 AND x.released_at IS NULL "
      + "LEFT JOIN voice_agents agent "
      + "ON agent.phone_number_id = n.id AND agent.tenant_id = $1 "
      + "AND agent.deleted_at IS NULL AND agent.status <> 'archived' "
      + "WHERE n.deleted_at IS NULL AND n.assigned_tenant_id = $1 "
      + "ORDER BY n.e164",
      [auth.tenantId],
    );
    return result.rows.map(mapTenantPhone);
  });
}

function mapTenantPhone(row) {
  return {
    id: row.id,
    number: row.e164,
    countryIso: row.country_iso,
    numberType: row.number_type,
    capabilities: row.capabilities,
    status: row.status,
    assignedAt: row.assigned_at,
    assignedAgent: row.agent_id ? {
      id: row.agent_id,
      name: row.agent_name,
      status: row.agent_status,
    } : null,
  };
}

async function tenantPhoneRow(client, tenantId, phoneNumberId) {
  const result = await client.query(
    "SELECT n.id, n.e164, n.country_iso, n.number_type, n.capabilities, n.status, "
    + "x.assigned_at, agent.id AS agent_id, agent.name AS agent_name, "
    + "agent.status AS agent_status "
    + "FROM phone_numbers n "
    + "JOIN phone_number_assignments x "
    + "ON x.phone_number_id = n.id AND x.tenant_id = $1 AND x.released_at IS NULL "
    + "LEFT JOIN voice_agents agent "
    + "ON agent.phone_number_id = n.id AND agent.tenant_id = $1 "
    + "AND agent.deleted_at IS NULL AND agent.status <> 'archived' "
    + "WHERE n.id = $2 AND n.deleted_at IS NULL AND n.assigned_tenant_id = $1",
    [tenantId, phoneNumberId],
  );
  if (!result.rowCount) {
    throw new AppError(404, 'Company phone number was not found', 'TENANT_PHONE_NUMBER_NOT_FOUND');
  }
  return result.rows[0];
}

export function mapTenantPhoneNumberAgent(auth, phoneNumberId, agentId) {
  return withTenantContext(auth, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['tenant-phone:' + auth.tenantId + ':' + phoneNumberId],
    );
    const phone = await client.query(
      "SELECT n.id, n.status FROM phone_numbers n "
      + "JOIN phone_number_assignments assignment "
      + "ON assignment.phone_number_id = n.id "
      + "AND assignment.tenant_id = $1 AND assignment.released_at IS NULL "
      + "WHERE n.id = $2 AND n.assigned_tenant_id = $1 AND n.deleted_at IS NULL",
      [auth.tenantId, phoneNumberId],
    );
    if (!phone.rowCount) {
      throw new AppError(404, 'Company phone number was not found', 'TENANT_PHONE_NUMBER_NOT_FOUND');
    }
    if (phone.rows[0].status !== 'active') {
      throw new AppError(409, 'Only active company phone numbers can be mapped', 'TENANT_PHONE_NUMBER_NOT_ACTIVE');
    }

    const current = await client.query(
      "SELECT id, name FROM voice_agents "
      + "WHERE tenant_id = $1 AND phone_number_id = $2 "
      + "AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE",
      [auth.tenantId, phoneNumberId],
    );
    let target = null;
    if (agentId) {
      const targetResult = await client.query(
        "SELECT id, name, phone_number_id FROM voice_agents "
        + "WHERE tenant_id = $1 AND id = $2 "
        + "AND deleted_at IS NULL AND status <> 'archived' FOR UPDATE",
        [auth.tenantId, agentId],
      );
      if (!targetResult.rowCount) {
        throw new AppError(404, 'Company voice agent was not found', 'TENANT_PHONE_AGENT_NOT_FOUND');
      }
      target = targetResult.rows[0];
    }

    const currentAgent = current.rows[0] || null;
    if ((currentAgent?.id || null) !== (target?.id || null)) {
      await client.query(
        "UPDATE voice_agents SET phone_number_id = NULL, updated_by = $4 "
        + "WHERE tenant_id = $1 AND deleted_at IS NULL "
        + "AND (phone_number_id = $2 OR ($3::uuid IS NOT NULL AND id = $3))",
        [auth.tenantId, phoneNumberId, target?.id || null, auth.userId],
      );
      if (target) {
        await client.query(
          "UPDATE voice_agents SET phone_number_id = $3, updated_by = $4 "
          + "WHERE tenant_id = $1 AND id = $2",
          [auth.tenantId, target.id, phoneNumberId, auth.userId],
        );
      }
      await client.query(
        "INSERT INTO audit_logs "
        + "(tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, "
        + "entity_id, before_data, after_data) "
        + "VALUES ($1, $2, $3, 'user', $4, 'phone_number', $5, $6::jsonb, $7::jsonb)",
        [
          auth.tenantId,
          auth.workspaceId,
          auth.userId,
          target ? 'PHONE_NUMBER_AGENT_MAPPED' : 'PHONE_NUMBER_AGENT_UNMAPPED',
          phoneNumberId,
          JSON.stringify({ agentId: currentAgent?.id || null, agentName: currentAgent?.name || null }),
          JSON.stringify({ agentId: target?.id || null, agentName: target?.name || null }),
        ],
      );
    }
    return mapTenantPhone(await tenantPhoneRow(client, auth.tenantId, phoneNumberId));
  });
}
