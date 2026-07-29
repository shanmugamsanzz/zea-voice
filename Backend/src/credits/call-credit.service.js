import crypto from 'node:crypto';
import { withAuthServiceContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import {
  calculateCallCharge,
  creditsForConnectedDuration,
  evaluateCallCreditAdmission,
  getCompanyCreditStatus,
} from './credit-billing-rules.js';

const asNumber = (value) => Number(value);

async function creditSnapshot(client, tenantId, lock = false) {
  const result = await client.query(`
    SELECT w.id AS wallet_id,w.balance,w.reserved_balance,
      w.balance-w.reserved_balance AS available_credits,
      o.per_minute_price,s.low_credit_threshold
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
    perMinutePrice: String(row.per_minute_price),
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
    priceSnapshotInr: admission.perMinutePrice,
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
 * The call's one-credit reservation is released and ceil(connected seconds / 60) is
 * charged exactly once. An admitted call may finish with a negative wallet balance;
 * subsequent calls remain blocked until credits are added.
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
  const credits = creditsForConnectedDuration(durationSeconds);
  const wallet = await creditSnapshot(client, call.tenant_id, true);
  const reservation = Math.max(0, asNumber(call.reserved_credits ?? 0));
  const price = String(call.credit_price_snapshot_inr ?? wallet.perMinutePrice);
  const charge = calculateCallCharge({ durationSeconds, perMinutePrice: price });
  const updatedWallet = (await client.query(`UPDATE company_credit_wallets
    SET balance=balance-$2,
        reserved_balance=GREATEST(0,reserved_balance-$3)
    WHERE id=$1 RETURNING balance,reserved_balance,balance-reserved_balance AS available_balance`,
  [wallet.walletId, credits, reservation])).rows[0];

  if (credits > 0) {
    await client.query(`INSERT INTO credit_ledger_entries
      (transaction_group_id,company_wallet_id,tenant_id,entry_type,direction,amount,credit_amount,
       balance_after,call_session_id,billed_duration_seconds,price_per_credit_inr,
       description,metadata)
      VALUES($1,$2,$3,'usage_debit','debit',$4,$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (call_session_id)
      WHERE call_session_id IS NOT NULL AND entry_type='usage_debit' DO NOTHING`, [
      crypto.randomUUID(), wallet.walletId, call.tenant_id, credits, updatedWallet.balance,
      call.id, Math.max(0, Math.ceil(Number(durationSeconds) || 0)), price,
      `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call usage`,
      JSON.stringify({
        direction: call.direction,
        billedMinutes: charge.billedMinutes,
        chargeAmountInr: charge.chargeAmount,
        reservationReleased: reservation,
      }),
    ]);
  }
  await client.query(`UPDATE call_sessions
    SET reserved_credits=0,credits_charged=$2,credit_billing_finalized=true,
        provider_metadata=COALESCE(provider_metadata,'{}'::jsonb)||$3::jsonb
    WHERE id=$1`, [call.id, credits, JSON.stringify({ creditBilling: {
      finalized: true,
      creditsCharged: credits,
      billedDurationSeconds: charge.durationSeconds,
      pricePerCreditInr: charge.perMinutePrice,
      chargeAmountInr: charge.chargeAmount,
      availableCreditsAfterCharge: asNumber(updatedWallet.available_balance),
    } })]);
  return {
    idempotent: false,
    creditsCharged: credits,
    availableCredits: asNumber(updatedWallet.available_balance),
    status: getCompanyCreditStatus({
      availableCredits: asNumber(updatedWallet.available_balance),
      lowCreditThreshold: wallet.lowCreditThreshold,
    }),
  };
}
