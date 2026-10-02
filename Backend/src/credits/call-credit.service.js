import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import {
  evaluateCallCreditAdmission,
  getCompanyCreditStatus,
} from './credit-billing-rules.js';

const asNumber = (value) => Number(value);

async function creditSnapshot(client, tenantId, lock = false) {
  const result = await client.query(`
    SELECT w.id AS wallet_id,w.balance,w.reserved_balance,
      w.balance-w.reserved_balance AS available_credits,
      s.low_credit_threshold
    FROM company_credit_wallets w
    JOIN organizations o ON o.tenant_id=w.tenant_id AND o.deleted_at IS NULL
    CROSS JOIN platform_credit_settings s
    WHERE w.tenant_id=$1 AND s.singleton_key=1
    ${lock ? 'FOR UPDATE OF w' : ''}`, [tenantId]);
  if (!result.rowCount) {
    throw new AppError(409, 'Company credit wallet or global credit settings are unavailable',
      'COMPANY_CREDIT_CONFIGURATION_MISSING');
  }
  const row = result.rows[0];
  return {
    walletId: row.wallet_id,
    balance: asNumber(row.balance),
    reservedCredits: asNumber(row.reserved_balance),
    availableCredits: asNumber(row.available_credits),
    lowCreditThreshold: asNumber(row.low_credit_threshold),
  };
}

function admissionError(decision, snapshot) {
  const details = {
    creditStatus: decision.status,
    availableCredits: snapshot.availableCredits,
    lowCreditThreshold: snapshot.lowCreditThreshold,
  };
  if (decision.reason === 'company_low_credit_outbound_blocked') {
    return new AppError(409,
      `Outbound calls are paused because the company has ${snapshot.availableCredits} credits remaining. Add credits to continue.`,
      'COMPANY_LOW_CREDIT_OUTBOUND_BLOCKED', details);
  }
  return new AppError(409, 'The company has no available call credits. Add credits to continue.',
    'COMPANY_CREDITS_EXHAUSTED', details);
}

export async function readTenantCreditAdmission(client, tenantId, direction, options = {}) {
  const snapshot = await creditSnapshot(client, tenantId, Boolean(options.lock));
  const decision = evaluateCallCreditAdmission({
    direction,
    availableCredits: snapshot.availableCredits,
    lowCreditThreshold: snapshot.lowCreditThreshold,
  });
  return { ...snapshot, ...decision };
}

export function assertTenantCallCreditAdmission(client, tenantId, direction) {
  return readTenantCreditAdmission(client, tenantId, direction).then((result) => {
    if (!result.allowed) throw admissionError(result, result);
    return result;
  });
}

export async function reserveTenantCallCredit(client, { tenantId, direction }) {
  const admission = await readTenantCreditAdmission(client, tenantId, direction, { lock: true });
  if (!admission.allowed) throw admissionError(admission, admission);
  await client.query(`UPDATE company_credit_wallets
    SET reserved_balance=reserved_balance+1 WHERE id=$1`, [admission.walletId]);
  return {
    reservedCredits: 1,
    priceSnapshotInr: null,
    availableCreditsAfterReservation: admission.availableCredits - 1,
    lowCreditThreshold: admission.lowCreditThreshold,
  };
}

export function checkTenantCallCreditAdmission(tenantId, direction, dependencies = {}) {
  const contextRunner = dependencies.contextRunner ?? withAuthServiceContext;
  return contextRunner((client) => assertTenantCallCreditAdmission(client, tenantId, direction));
}

/**
 * Finalizes one admitted call while the caller holds a FOR UPDATE lock on the call row.
 * The legacy one-credit admission reservation is released here. Usage pricing is
 * finalized by the Phase 2 metered-usage billing flow, not by call duration.
 */
export async function finalizeCallCreditBilling(client, { call, durationSeconds }) {
  if (!call?.id || !call.tenant_id) throw new TypeError('A locked call session is required');
  if (call.credit_billing_finalized) {
    return { idempotent: true, creditsCharged: asNumber(call.credits_charged ?? 0) };
  }
  const existingDebit = await client.query(`SELECT credit_amount,amount
    FROM credit_ledger_entries
    WHERE call_session_id=$1 AND entry_type='usage_debit' LIMIT 1`, [call.id]);
  if (existingDebit.rowCount) {
    const wallet = await creditSnapshot(client, call.tenant_id, true);
    const reservation = Math.max(0, asNumber(call.reserved_credits ?? 0));
    if (reservation > 0) {
      await client.query(`UPDATE company_credit_wallets
        SET reserved_balance=GREATEST(0,reserved_balance-$2) WHERE id=$1`,
      [wallet.walletId, reservation]);
    }
    const charged = asNumber(existingDebit.rows[0].credit_amount ?? existingDebit.rows[0].amount ?? 0);
    await client.query(`UPDATE call_sessions SET reserved_credits=0,credits_charged=$2,
      credit_billing_finalized=true WHERE id=$1`, [call.id, charged]);
    return { idempotent: true, creditsCharged: charged };
  }
  const costResult = await client.query(`SELECT COALESCE(sum(cost_inr),0)::numeric AS total_cost_inr,
      count(*)::int AS cost_line_count
    FROM call_metered_usage_costs WHERE call_session_id=$1`, [call.id]);
  const totalCost = Math.max(0, asNumber(costResult.rows[0]?.total_cost_inr));
  const costLineCount = Math.max(0, Number(costResult.rows[0]?.cost_line_count ?? 0));
  const wallet = await creditSnapshot(client, call.tenant_id, true);
  const reservation = Math.max(0, asNumber(call.reserved_credits ?? 0));
  const updatedWallet = (await client.query(`UPDATE company_credit_wallets
    SET balance=balance-$2,reserved_balance=GREATEST(0,reserved_balance-$3)
    WHERE id=$1 RETURNING balance,reserved_balance,balance-reserved_balance AS available_balance`,
  [wallet.walletId, totalCost, reservation])).rows[0];
  if (totalCost > 0) {
    await client.query(`INSERT INTO credit_ledger_entries
      (company_wallet_id,tenant_id,entry_type,direction,amount,credit_amount,balance_after,
       price_per_credit_inr,call_session_id,reference,description,metadata)
      VALUES($1,$2,'usage_debit','debit',$3::numeric,$3::numeric,$4,1,$5,$6,$7,$8::jsonb)`, [
      wallet.walletId, call.tenant_id, totalCost, updatedWallet.balance, call.id,
      `metered-call:${call.id}`, 'Metered provider and telephony usage',
      JSON.stringify({ billingMode: 'metered_usage', totalCostInr: totalCost, costLineCount, creditValueInr: 1 }),
    ]);
  }
  await client.query(`UPDATE call_sessions
    SET reserved_credits=0,credits_charged=$2,credit_billing_finalized=true,
        provider_metadata=COALESCE(provider_metadata,'{}'::jsonb)||$3::jsonb
    WHERE id=$1`, [call.id, totalCost, JSON.stringify({ creditBilling: {
      finalized: true,
      creditsCharged: totalCost,
      billingMode: 'metered_usage',
      costLineCount,
      creditValueInr: 1,
      availableCreditsAfterCharge: asNumber(updatedWallet.available_balance),
    } })]);
  return {
    idempotent: false,
    creditsCharged: totalCost,
    availableCredits: asNumber(updatedWallet.available_balance),
    status: getCompanyCreditStatus({
      availableCredits: asNumber(updatedWallet.available_balance),
      lowCreditThreshold: wallet.lowCreditThreshold,
    }),
  };
}
