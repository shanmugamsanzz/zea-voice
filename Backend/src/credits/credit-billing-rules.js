const MONEY_SCALE = 100_000_000n;
const MONEY_DECIMALS = 8;

export const CREDIT_ADMISSION_REASON = Object.freeze({
  ALLOWED: 'allowed',
  EXHAUSTED: 'company_credits_exhausted',
  OUTBOUND_THRESHOLD_REACHED: 'company_low_credit_outbound_blocked',
});

function decimalToUnits(value, fieldName) {
  const normalized = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,8}))?$/.exec(normalized);
  if (!match) {
    throw new TypeError(`${fieldName} must be a non-negative decimal with at most eight decimal places`);
  }

  const fraction = (match[2] ?? '').padEnd(MONEY_DECIMALS, '0');
  return (BigInt(match[1]) * MONEY_SCALE) + BigInt(fraction || '0');
}

function unitsToDecimal(units) {
  const whole = units / MONEY_SCALE;
  const fraction = String(units % MONEY_SCALE).padStart(MONEY_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function creditQuantity(value, fieldName, options = {}) {
  const normalized = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isFinite(normalized) || (!options.allowNegative && normalized < 0)) {
    throw new TypeError(`${fieldName} must be ${options.allowNegative ? 'a' : 'a non-negative'} credit amount`);
  }
  return normalized;
}

/**
 * One company credit is always one INR. This conversion no longer depends on a
 * company-specific call-duration price.
 */
export function convertPaymentToCredits({ paymentAmount, remainderAmount = '0' }) {
  const paymentUnits = decimalToUnits(paymentAmount, 'paymentAmount');
  const priceUnits = MONEY_SCALE;
  const remainderUnits = decimalToUnits(remainderAmount, 'remainderAmount');
  if (paymentUnits <= 0n) throw new TypeError('paymentAmount must be greater than zero');
  const totalUnits = paymentUnits + remainderUnits;
  const creditsUnits = totalUnits;
  return {
    credits: Number(creditsUnits) / Number(MONEY_SCALE),
    paymentAmount: unitsToDecimal(paymentUnits),
    previousRemainderAmount: unitsToDecimal(remainderUnits),
    totalAvailableAmount: unitsToDecimal(totalUnits),
    consumedAmount: unitsToDecimal(creditsUnits),
    remainderAmount: '0',
    creditValueInr: unitsToDecimal(priceUnits),
  };
}

export function getCompanyCreditStatus({ availableCredits, lowCreditThreshold }) {
  const available = creditQuantity(availableCredits, 'availableCredits', { allowNegative: true });
  const threshold = creditQuantity(lowCreditThreshold, 'lowCreditThreshold');
  if (available <= 0) return 'exhausted';
  if (available <= threshold) return 'low';
  return 'available';
}

/**
 * Outbound work is blocked at or below the Super Admin threshold. Inbound calls
 * remain available while at least one credit exists. Both directions stop at zero.
 */
export function evaluateCallCreditAdmission({ direction, availableCredits, lowCreditThreshold }) {
  if (!['inbound', 'outbound'].includes(direction)) {
    throw new TypeError('direction must be inbound or outbound');
  }
  const available = creditQuantity(availableCredits, 'availableCredits', { allowNegative: true });
  const threshold = creditQuantity(lowCreditThreshold, 'lowCreditThreshold');

  if (available <= 0) {
    return { allowed: false, reason: CREDIT_ADMISSION_REASON.EXHAUSTED, status: 'exhausted' };
  }
  if (direction === 'outbound' && available <= threshold) {
    return {
      allowed: false,
      reason: CREDIT_ADMISSION_REASON.OUTBOUND_THRESHOLD_REACHED,
      status: 'low',
    };
  }
  return {
    allowed: true,
    reason: CREDIT_ADMISSION_REASON.ALLOWED,
    status: available <= threshold ? 'low' : 'available',
  };
}
