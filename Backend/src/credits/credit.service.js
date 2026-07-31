import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';
import { wakeCreditWaitingTasks } from '../campaigns/campaign-execution.service.js';
import { decryptCredential } from '../security/credential-crypto.js';
import { getPlivoAccountDetails } from '../telephony/plivo.client.js';
import { redis } from '../infrastructure/redis.js';
import { logger } from '../config/logger.js';
import { convertPaymentToCredits, getCompanyCreditStatus } from './credit-billing-rules.js';

const number = (value) => Number(value);
const mapWallet = (row, options = {}) => {
  const wallet = {
    id: row.id,
    companyId: row.tenant_id ?? undefined,
    companyName: row.company_name ?? undefined,
    unit: row.unit ?? (row.tenant_id ? 'credit' : undefined),
    balance: number(row.balance),
    reservedBalance: number(row.reserved_balance),
    availableBalance: number(row.available_balance ?? (number(row.balance) - number(row.reserved_balance))),
    lowBalanceThreshold: row.low_balance_threshold === undefined ? undefined : number(row.low_balance_threshold),
    updatedAt: row.updated_at,
  };
  if (options.includePrivateFinancials && row.tenant_id) {
    wallet.perMinutePrice = number(row.per_minute_price);
    wallet.inrRemainder = number(row.inr_remainder);
  }
  return wallet;
};
const mapLedger = (row, options = {}) => {
  const entry = {
    id: row.id,
    transactionGroupId: row.transaction_group_id,
    companyId: row.tenant_id,
    companyName: row.company_name ?? null,
    type: row.entry_type,
    direction: row.direction,
    amount: number(row.amount),
    creditAmount: row.credit_amount === null || row.credit_amount === undefined
      ? null : number(row.credit_amount),
    balanceAfter: number(row.balance_after),
    unit: row.company_wallet_id ? 'credit' : row.currency,
    reference: row.reference,
    description: row.description,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name ?? null,
    callSessionId: row.call_session_id ?? null,
    billedDurationSeconds: row.billed_duration_seconds ?? null,
    createdAt: row.created_at,
  };
  if (options.includePrivateFinancials) {
    entry.paymentAmountInr = row.payment_amount_inr === null ? null : number(row.payment_amount_inr);
    entry.pricePerCreditInr = row.price_per_credit_inr === null ? null : number(row.price_per_credit_inr);
    entry.remainderBeforeInr = row.remainder_before_inr === null ? null : number(row.remainder_before_inr);
    entry.remainderAfterInr = row.remainder_after_inr === null ? null : number(row.remainder_after_inr);
  }
  return entry;
};

const mapPayment = (row) => ({
  paymentId: row.id,
  paymentAmountInr: number(row.payment_amount_inr),
  creditsIssued: number(row.credits_issued),
  perMinutePrice: number(row.price_per_credit_inr),
  previousRemainderInr: number(row.remainder_before_inr),
  remainderInr: number(row.remainder_after_inr),
  createdAt: row.created_at,
});

async function companyWallet(client, companyId, lock = false) {
  const result = await client.query(`
    SELECT w.*, o.name AS company_name, o.per_minute_price,
           w.balance - w.reserved_balance AS available_balance
    FROM company_credit_wallets w
    JOIN organizations o ON o.tenant_id = w.tenant_id AND o.deleted_at IS NULL
    WHERE w.tenant_id = $1 ${lock ? 'FOR UPDATE OF w' : ''}`, [companyId]);
  if (!result.rowCount) throw new AppError(404, 'Company credit wallet was not found', 'COMPANY_WALLET_NOT_FOUND');
  return result.rows[0];
}

export async function getAdminCreditSummary(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const companies = await client.query(`SELECT w.*, o.name AS company_name, o.per_minute_price,
        w.balance - w.reserved_balance AS available_balance
        FROM company_credit_wallets w JOIN organizations o ON o.tenant_id = w.tenant_id
        WHERE o.deleted_at IS NULL ORDER BY o.name`);
    const settings = (await client.query(`SELECT low_credit_threshold,updated_at
      FROM platform_credit_settings WHERE singleton_key=1`)).rows[0];
    return {
      globalLowCreditThreshold: number(settings.low_credit_threshold),
      thresholdUpdatedAt: settings.updated_at,
      companyWallets: companies.rows.map((row) => mapWallet(row, { includePrivateFinancials: true })),
    };
  });
}

export async function updateGlobalCreditThreshold(actorUserId, input) {
  const outcome = await withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(`UPDATE platform_credit_settings
      SET low_credit_threshold=$1,updated_by=$2 WHERE singleton_key=1
      RETURNING low_credit_threshold,updated_at`, [input.lowCreditThreshold, actorUserId]);
    const eligible = await client.query(`SELECT DISTINCT t.tenant_id
      FROM campaign_tasks t
      JOIN company_credit_wallets w ON w.tenant_id=t.tenant_id
      WHERE t.status='queued' AND t.queue_reason='waiting_credits'
        AND w.balance-w.reserved_balance>$1`, [input.lowCreditThreshold]);
    return {
      globalLowCreditThreshold: number(result.rows[0].low_credit_threshold),
      thresholdUpdatedAt: result.rows[0].updated_at,
      eligibleTenantIds: eligible.rows.map((row) => row.tenant_id),
    };
  });
  await Promise.allSettled(outcome.eligibleTenantIds.map((tenantId) => wakeCreditWaitingTasks(tenantId)));
  return {
    globalLowCreditThreshold: outcome.globalLowCreditThreshold,
    thresholdUpdatedAt: outcome.thresholdUpdatedAt,
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

export function previewCompanyCreditPurchase(actorUserId, companyId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const company = await companyWallet(client, companyId);
    const conversion = convertPaymentToCredits({
      paymentAmount: input.amount,
      perMinutePrice: company.per_minute_price,
      remainderAmount: company.inr_remainder,
    });
    return {
      companyId,
      companyName: company.company_name,
      currentCredits: number(company.available_balance),
      projectedCredits: number(company.available_balance) + conversion.credits,
      paymentAmountInr: number(conversion.paymentAmount),
      creditsIssued: conversion.credits,
      perMinutePrice: number(conversion.perMinutePrice),
      previousRemainderInr: number(conversion.previousRemainderAmount),
      remainderInr: number(conversion.remainderAmount),
    };
  });
}

export function allocateCompanyCredits(actorUserId, companyId, input, idempotencyKey) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const company = await companyWallet(client, companyId, true);
    const existing = (await client.query(
      `SELECT * FROM company_credit_payments
       WHERE tenant_id=$1 AND idempotency_key=$2`,
      [companyId, idempotencyKey],
    )).rows[0];
    if (existing) {
      if (number(existing.payment_amount_inr) !== number(input.amount)) {
        throw new AppError(409, 'Idempotency key was already used for a different payment amount', 'IDEMPOTENCY_KEY_CONFLICT');
      }
      return {
        ...mapWallet(company, { includePrivateFinancials: true }),
        allocation: mapPayment(existing),
        idempotentReplay: true,
      };
    }
    const conversion = convertPaymentToCredits({
      paymentAmount: input.amount,
      perMinutePrice: company.per_minute_price,
      remainderAmount: company.inr_remainder,
    });
    const group = crypto.randomUUID();
    const credited = (await client.query(`UPDATE company_credit_wallets
      SET balance = balance + $2, inr_remainder = $3
      WHERE id = $1
      RETURNING *, balance - reserved_balance AS available_balance`,
    [company.id, conversion.credits, conversion.remainderAmount])).rows[0];
    const payment = (await client.query(`INSERT INTO company_credit_payments
      (tenant_id,company_wallet_id,payment_amount_inr,price_per_credit_inr,
       remainder_before_inr,credits_issued,remainder_after_inr,reference,description,idempotency_key,actor_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [companyId, company.id, conversion.paymentAmount, conversion.perMinutePrice,
      conversion.previousRemainderAmount, conversion.credits, conversion.remainderAmount,
      input.reference ?? null, input.description ?? null, idempotencyKey, actorUserId])).rows[0];
    if (conversion.credits > 0) {
      await client.query(`INSERT INTO credit_ledger_entries
        (transaction_group_id,company_wallet_id,tenant_id,entry_type,direction,amount,credit_amount,
         balance_after,payment_amount_inr,price_per_credit_inr,remainder_before_inr,remainder_after_inr,
         reference,description,actor_user_id,metadata)
        VALUES ($1,$2,$3,'company_allocation','credit',$4::bigint,$4::bigint,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [group, company.id, companyId, conversion.credits, credited.balance, conversion.paymentAmount,
        conversion.perMinutePrice, conversion.previousRemainderAmount, conversion.remainderAmount,
        input.reference ?? null, input.description ?? null, actorUserId,
        JSON.stringify({ paymentId: payment.id })]);
    }
    return {
      ...mapWallet({ ...credited, company_name: company.company_name,
        per_minute_price: company.per_minute_price }, { includePrivateFinancials: true }),
      allocation: mapPayment(payment),
      idempotentReplay: false,
    };
  }).then(async (wallet) => {
    if (!wallet.idempotentReplay && wallet.allocation.creditsIssued > 0) await wakeCreditWaitingTasks(companyId);
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
      (company_wallet_id, tenant_id, entry_type, direction, amount, credit_amount, balance_after,
       reference, description, actor_user_id)
      VALUES ($1, $2, $3, $4, $5::bigint, $5::bigint, $6, $7, $8, $9)`,
    [company.id, companyId, input.type, input.direction, input.amount, updated.balance,
      input.reference ?? null, input.description, actorUserId]);
    return mapWallet({ ...updated, company_name: company.company_name });
  });
}

export function listAdminLedger(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => listLedger(client, filters, null, true));
}

export function listAdminPayments(actorUserId, filters) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const offset = (filters.page - 1) * filters.pageSize;
    const result = await client.query(
      `SELECT count(*) OVER()::int AS full_count, p.*, o.name AS company_name,
              concat_ws(' ', u.first_name, u.last_name) AS actor_name
       FROM company_credit_payments p
       JOIN organizations o ON o.tenant_id = p.tenant_id AND o.deleted_at IS NULL
       LEFT JOIN users u ON u.id = p.actor_user_id
       WHERE ($1::uuid IS NULL OR p.tenant_id = $1)
       ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [filters.companyId ?? null, filters.pageSize, offset],
    );
    const total = result.rows[0]?.full_count ?? 0;
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        companyId: row.tenant_id,
        companyName: row.company_name,
        paymentAmountInr: number(row.payment_amount_inr),
        perMinutePrice: number(row.price_per_credit_inr),
        remainderBeforeInr: number(row.remainder_before_inr),
        creditsIssued: number(row.credits_issued),
        remainderAfterInr: number(row.remainder_after_inr),
        reference: row.reference,
        description: row.description,
        actorUserId: row.actor_user_id,
        actorName: row.actor_name || null,
        createdAt: row.created_at,
      })),
      pagination: {
        page: filters.page,
        pageSize: filters.pageSize,
        total,
        totalPages: Math.ceil(total / filters.pageSize),
      },
    };
  });
}

async function listLedger(client, filters, tenantId = null, includePrivateFinancials = false) {
  const companyId = tenantId ?? filters.companyId ?? null;
  const values = [companyId, filters.type ?? null];
  const where = `WHERE l.company_wallet_id IS NOT NULL
    AND ($1::uuid IS NULL OR l.tenant_id = $1)
    AND ($2::credit_entry_type IS NULL OR l.entry_type = $2)`;
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
  return { items: result.rows.map((row) => mapLedger(row, { includePrivateFinancials })), pagination: {
    page: filters.page, pageSize: filters.pageSize, total,
    totalPages: Math.ceil(total / filters.pageSize),
  } };
}

export function getTenantCredits(auth, filters) {
  return withTenantContext(auth, async (client) => {
    const wallet = await companyWallet(client, auth.tenantId);
    const settings = (await client.query(`SELECT low_credit_threshold
      FROM platform_credit_settings WHERE singleton_key=1`)).rows[0];
    const mapped = mapWallet(wallet);
    const threshold = number(settings.low_credit_threshold);
    return {
      wallet: {
        ...mapped,
        globalLowCreditThreshold: threshold,
        creditStatus: getCompanyCreditStatus({
          availableCredits: mapped.availableBalance,
          lowCreditThreshold: threshold,
        }),
      },
      ledger: await listLedger(client, filters, auth.tenantId),
    };
  });
}

export function hasAvailableCompanyCredits(auth, requiredAmount = '0.0001') {
  return withTenantContext(auth, async (client) => {
    const wallet = await companyWallet(client, auth.tenantId);
    return number(wallet.available_balance) >= number(requiredAmount);
  });
}
