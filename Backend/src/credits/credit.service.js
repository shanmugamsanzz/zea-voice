import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { withParallelPlatformAdminContext, withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { wakeCreditWaitingTasks } from '../campaigns/campaign-execution.service.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { getPlivoAccountDetails } from '../telephony/plivo.client.js';
import { redis } from '../infrastructure/redis.js';
import { logger } from '../config/logger.js';

const number = (value) => Number(value);
const mapWallet = (row) => ({
  id: row.id,
  companyId: row.tenant_id ?? undefined,
  companyName: row.company_name ?? undefined,
  currency: row.currency,
  balance: number(row.balance),
  reservedBalance: number(row.reserved_balance),
  availableBalance: number(row.available_balance ?? (number(row.balance) - number(row.reserved_balance))),
  lowBalanceThreshold: row.low_balance_threshold === undefined ? undefined : number(row.low_balance_threshold),
  updatedAt: row.updated_at,
});
const mapLedger = (row) => ({
  id: row.id,
  transactionGroupId: row.transaction_group_id,
  companyId: row.tenant_id,
  companyName: row.company_name ?? null,
  type: row.entry_type,
  direction: row.direction,
  amount: number(row.amount),
  balanceAfter: number(row.balance_after),
  currency: row.currency,
  reference: row.reference,
  description: row.description,
  actorUserId: row.actor_user_id,
  actorName: row.actor_name ?? null,
  createdAt: row.created_at,
});

async function platformWallet(client, lock = false) {
  const result = await client.query(`SELECT *, balance - reserved_balance AS available_balance
    FROM platform_credit_wallets WHERE currency = 'INR' ${lock ? 'FOR UPDATE' : ''}`);
  if (!result.rowCount) throw new AppError(500, 'Platform credit wallet is missing', 'PLATFORM_WALLET_MISSING');
  return result.rows[0];
}

async function companyWallet(client, companyId, lock = false) {
  const result = await client.query(`
    SELECT w.*, o.name AS company_name, w.balance - w.reserved_balance AS available_balance
    FROM company_credit_wallets w
    JOIN organizations o ON o.tenant_id = w.tenant_id AND o.deleted_at IS NULL
    WHERE w.tenant_id = $1 ${lock ? 'FOR UPDATE OF w' : ''}`, [companyId]);
  if (!result.rowCount) throw new AppError(404, 'Company credit wallet was not found', 'COMPANY_WALLET_NOT_FOUND');
  return result.rows[0];
}

export async function getAdminCreditSummary(actorUserId) {
  const [platform, companies, rates] = await withParallelPlatformAdminContext(actorUserId, [
    (client) => platformWallet(client),
    (client) => client.query(`SELECT w.*, o.name AS company_name, w.balance - w.reserved_balance AS available_balance
        FROM company_credit_wallets w JOIN organizations o ON o.tenant_id = w.tenant_id
        WHERE o.deleted_at IS NULL ORDER BY o.name`),
    (client) => client.query('SELECT direction, rate_per_minute, currency, effective_from, updated_at FROM platform_pricing_rates ORDER BY direction'),
  ]);
  return {
    platformWallet: mapWallet(platform),
    companyWallets: companies.rows.map(mapWallet),
    pricing: Object.fromEntries(rates.rows.map((row) => [row.direction, {
      ratePerMinute: number(row.rate_per_minute), currency: row.currency,
      effectiveFrom: row.effective_from, updatedAt: row.updated_at,
    }])),
  };
}

const providerBalanceCacheKey = (accountId) => `${env.QUEUE_PREFIX}:provider-balance:v1:${accountId}`;

async function cacheCommand(operation) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Provider balance cache timed out')), env.PROVIDER_BALANCE_CACHE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readProviderBalanceCache(accountId) {
  try {
    const cached = await cacheCommand(redis.get(providerBalanceCacheKey(accountId)));
    return cached ? JSON.parse(cached) : null;
  } catch (error) {
    logger.warn({ err: error, accountId }, 'Provider balance cache read failed');
    return null;
  }
}

async function writeProviderBalanceCache(accountId, balance) {
  try {
    await cacheCommand(redis.set(providerBalanceCacheKey(accountId), JSON.stringify(balance), 'EX', env.PROVIDER_BALANCE_CACHE_TTL_SECONDS));
  } catch (error) {
    logger.warn({ err: error, accountId }, 'Provider balance cache write failed');
  }
}

export async function getProviderCreditBalances(actorUserId, fetchImpl = fetch, options = {}) {
  const accounts = await withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(`
      SELECT id, provider, name, auth_id, auth_token_encrypted, base_url, status
      FROM telephony_accounts
      WHERE account_type = 'main' AND deleted_at IS NULL
      ORDER BY created_at DESC
    `);
    return result.rows;
  });

  return Promise.all(accounts.map(async (account) => {
    const base = {
      telephonyAccountId: account.id,
      provider: account.provider,
      providerName: account.name,
      connectionStatus: account.status,
    };
    if (account.status !== 'connected') {
      return { ...base, available: false, error: 'Provider is disconnected' };
    }
    if (!options.forceRefresh) {
      const cached = await readProviderBalanceCache(account.id);
      if (cached) return { ...cached, cacheHit: true };
    }
    try {
      const details = await getPlivoAccountDetails(
        account.auth_id,
        decryptCredential(account.auth_token_encrypted),
        fetchImpl,
        account.base_url,
      );
      const sourceRemainingCredits = Number(details?.cash_credits);
      if (!Number.isFinite(sourceRemainingCredits)) {
        throw new AppError(502, 'Plivo returned an invalid credit balance', 'INVALID_PLIVO_CREDIT_BALANCE');
      }
      const remainingCredits = Number((sourceRemainingCredits * env.PLIVO_CREDIT_USD_TO_INR_RATE).toFixed(2));
      const balance = {
        ...base,
        available: true,
        remainingCredits,
        currency: 'INR',
        sourceRemainingCredits,
        sourceCurrency: 'USD',
        conversionRate: env.PLIVO_CREDIT_USD_TO_INR_RATE,
        billingMode: details.billing_mode ?? null,
        accountType: details.account_type ?? null,
        autoRecharge: Boolean(details.auto_recharge),
        fetchedAt: new Date().toISOString(),
        cacheHit: false,
      };
      await writeProviderBalanceCache(account.id, balance);
      return balance;
    } catch (error) {
      return {
        ...base,
        available: false,
        error: error instanceof AppError ? error.message : 'Plivo balance could not be loaded',
      };
    }
  }));
}

export function purchasePlatformCredits(actorUserId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const wallet = await platformWallet(client, true);
    const updated = (await client.query(`UPDATE platform_credit_wallets SET balance = balance + $2
      WHERE id = $1 RETURNING *, balance - reserved_balance AS available_balance`, [wallet.id, input.amount])).rows[0];
    await client.query(`INSERT INTO credit_ledger_entries
      (platform_wallet_id, entry_type, direction, amount, balance_after, reference, description, actor_user_id)
      VALUES ($1, 'platform_purchase', 'credit', $2, $3, $4, $5, $6)`,
    [wallet.id, input.amount, updated.balance, input.reference ?? null, input.description ?? null, actorUserId]);
    return mapWallet(updated);
  });
}

export function allocateCompanyCredits(actorUserId, companyId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const platform = await platformWallet(client, true);
    const company = await companyWallet(client, companyId, true);
    if (number(platform.balance) - number(platform.reserved_balance) < number(input.amount)) {
      throw new AppError(409, 'Platform wallet has insufficient available credits', 'INSUFFICIENT_PLATFORM_CREDITS');
    }
    const group = crypto.randomUUID();
    const debited = (await client.query(`UPDATE platform_credit_wallets SET balance = balance - $2
      WHERE id = $1 RETURNING *`, [platform.id, input.amount])).rows[0];
    const credited = (await client.query(`UPDATE company_credit_wallets SET balance = balance + $2
      WHERE id = $1 RETURNING *, balance - reserved_balance AS available_balance`, [company.id, input.amount])).rows[0];
    await client.query(`INSERT INTO credit_ledger_entries
      (transaction_group_id, platform_wallet_id, entry_type, direction, amount, balance_after,
       reference, description, actor_user_id)
      VALUES ($1, $2, 'company_allocation', 'debit', $3, $4, $5, $6, $7)`,
    [group, platform.id, input.amount, debited.balance, input.reference ?? null, input.description ?? null, actorUserId]);
    await client.query(`INSERT INTO credit_ledger_entries
      (transaction_group_id, company_wallet_id, tenant_id, entry_type, direction, amount, balance_after,
       reference, description, actor_user_id)
      VALUES ($1, $2, $3, 'company_allocation', 'credit', $4, $5, $6, $7, $8)`,
    [group, company.id, companyId, input.amount, credited.balance, input.reference ?? null, input.description ?? null, actorUserId]);
    return mapWallet({ ...credited, company_name: company.company_name });
  }).then(async (wallet) => {
    await wakeCreditWaitingTasks(companyId);
    return wallet;
  });
}

export function adjustCompanyCredits(actorUserId, companyId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const company = await companyWallet(client, companyId, true);
    const delta = input.direction === 'credit' ? input.amount : `-${input.amount}`;
    if (input.direction === 'debit' && number(company.balance) - number(company.reserved_balance) < number(input.amount)) {
      throw new AppError(409, 'Company wallet has insufficient available credits', 'INSUFFICIENT_COMPANY_CREDITS');
    }
    const updated = (await client.query(`UPDATE company_credit_wallets SET balance = balance + $2
      WHERE id = $1 RETURNING *, balance - reserved_balance AS available_balance`, [company.id, delta])).rows[0];
    await client.query(`INSERT INTO credit_ledger_entries
      (company_wallet_id, tenant_id, entry_type, direction, amount, balance_after,
       reference, description, actor_user_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [company.id, companyId, input.type, input.direction, input.amount, updated.balance,
      input.reference ?? null, input.description, actorUserId]);
    return mapWallet({ ...updated, company_name: company.company_name });
  });
}

export function updatePricing(actorUserId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    for (const [direction, rate] of [['inbound', input.inboundRate], ['outbound', input.outboundRate]]) {
      await client.query(`UPDATE platform_pricing_rates SET rate_per_minute = $2,
        effective_from = now(), updated_by = $3 WHERE direction = $1`, [direction, rate, actorUserId]);
    }
    const rows = await client.query('SELECT direction, rate_per_minute, currency, effective_from FROM platform_pricing_rates');
    return Object.fromEntries(rows.rows.map((row) => [row.direction, {
      ratePerMinute: number(row.rate_per_minute), currency: row.currency, effectiveFrom: row.effective_from,
    }]));
  });
}

export function listAdminLedger(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => listLedger(client, filters));
}

async function listLedger(client, filters, tenantId = null) {
  const companyId = tenantId ?? filters.companyId ?? null;
  const values = [companyId, filters.type ?? null];
  const where = `WHERE ($1::uuid IS NULL OR l.tenant_id = $1) AND ($2::credit_entry_type IS NULL OR l.entry_type = $2)`;
  const offset = (filters.page - 1) * filters.pageSize;
  const result = await client.query(`SELECT count(*) OVER()::int AS full_count,
      l.*, COALESCE(cw.currency, pw.currency) AS currency,
      o.name AS company_name, concat_ws(' ', u.first_name, u.last_name) AS actor_name
    FROM credit_ledger_entries l
    LEFT JOIN company_credit_wallets cw ON cw.id = l.company_wallet_id
    LEFT JOIN platform_credit_wallets pw ON pw.id = l.platform_wallet_id
    LEFT JOIN organizations o ON o.tenant_id = l.tenant_id AND o.deleted_at IS NULL
    LEFT JOIN users u ON u.id = l.actor_user_id
    ${where} ORDER BY l.created_at DESC LIMIT $3 OFFSET $4`, [...values, filters.pageSize, offset]);
  const total = result.rows[0]?.full_count ?? 0;
  return { items: result.rows.map(mapLedger), pagination: {
    page: filters.page, pageSize: filters.pageSize, total,
    totalPages: Math.ceil(total / filters.pageSize),
  } };
}

export function getTenantCredits(auth, filters) {
  return withTenantContext(auth, async (client) => ({
    wallet: mapWallet(await companyWallet(client, auth.tenantId)),
    ledger: await listLedger(client, filters, auth.tenantId),
    pricing: (await client.query('SELECT direction, rate_per_minute, currency, effective_from FROM platform_pricing_rates ORDER BY direction')).rows
      .map((row) => ({ direction: row.direction, ratePerMinute: number(row.rate_per_minute), currency: row.currency, effectiveFrom: row.effective_from })),
  }));
}

export function hasAvailableCompanyCredits(auth, requiredAmount = '0.0001') {
  return withTenantContext(auth, async (client) => {
    const wallet = await companyWallet(client, auth.tenantId);
    return number(wallet.available_balance) >= number(requiredAmount);
  });
}
