const MONEY_SCALE = 10_000n;
const MONEY_DECIMALS = 4;

export const CREDIT_ADMISSION_REASON = Object.freeze({
  ALLOWED: 'allowed',
  EXHAUSTED: 'company_credits_exhausted',
  OUTBOUND_THRESHOLD_REACHED: 'company_low_credit_outbound_blocked',
});

function decimalToUnits(value, fieldName) {
  const normalized = String(value ?? '').trim();
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(normalized);
  if (!match) {
    throw new TypeError(`${fieldName} must be a non-negative decimal with at most four decimal places`);
  }

  const fraction = (match[2] ?? '').padEnd(MONEY_DECIMALS, '0');
  return (BigInt(match[1]) * MONEY_SCALE) + BigInt(fraction || '0');
}

function unitsToDecimal(units) {
  const whole = units / MONEY_SCALE;
  const fraction = String(units % MONEY_SCALE).padStart(MONEY_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function wholeCredits(value, fieldName, options = {}) {
  const normalized = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isSafeInteger(normalized) || (!options.allowNegative && normalized < 0)) {
    throw new TypeError(`${fieldName} must be ${options.allowNegative ? 'a' : 'a non-negative'} whole number`);
  }
  return normalized;
}

/** Every started connected minute consumes one credit. */
export function creditsForConnectedDuration(durationSeconds) {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new TypeError('durationSeconds must be a non-negative finite number');
  }
  if (seconds === 0) return 0;
  return Math.ceil(seconds / 60);
}

export function calculateCallCharge({ durationSeconds, perMinutePrice }) {
  const credits = creditsForConnectedDuration(durationSeconds);
  const priceUnits = decimalToUnits(perMinutePrice, 'perMinutePrice');
  if (priceUnits <= 0n) throw new TypeError('perMinutePrice must be greater than zero');
  return {
    durationSeconds: Number(durationSeconds),
    billedMinutes: credits,
    credits,
    chargeAmount: unitsToDecimal(BigInt(credits) * priceUnits),
    perMinutePrice: unitsToDecimal(priceUnits),
  };
}

/**
 * Converts a Super Admin INR payment into whole call credits without floating-point
 * arithmetic. Any amount that cannot buy a complete credit remains in INR for the
 * company's next allocation.
 */
export function convertPaymentToCredits({ paymentAmount, perMinutePrice, remainderAmount = '0' }) {
  const paymentUnits = decimalToUnits(paymentAmount, 'paymentAmount');
  const priceUnits = decimalToUnits(perMinutePrice, 'perMinutePrice');
  const remainderUnits = decimalToUnits(remainderAmount, 'remainderAmount');
  if (paymentUnits <= 0n) throw new TypeError('paymentAmount must be greater than zero');
  if (priceUnits <= 0n) throw new TypeError('perMinutePrice must be greater than zero');
  const totalUnits = paymentUnits + remainderUnits;
  const creditsBigInt = totalUnits / priceUnits;
  if (creditsBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('The calculated credit count exceeds the supported safe integer range');
  }

  const consumedUnits = creditsBigInt * priceUnits;
  return {
    credits: Number(creditsBigInt),
    paymentAmount: unitsToDecimal(paymentUnits),
    previousRemainderAmount: unitsToDecimal(remainderUnits),
    totalAvailableAmount: unitsToDecimal(totalUnits),
    consumedAmount: unitsToDecimal(consumedUnits),
    remainderAmount: unitsToDecimal(totalUnits - consumedUnits),
    perMinutePrice: unitsToDecimal(priceUnits),
  };
}

export function getCompanyCreditStatus({ availableCredits, lowCreditThreshold }) {
  const available = wholeCredits(availableCredits, 'availableCredits', { allowNegative: true });
  const threshold = wholeCredits(lowCreditThreshold, 'lowCreditThreshold');
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
  const available = wholeCredits(availableCredits, 'availableCredits', { allowNegative: true });
  const threshold = wholeCredits(lowCreditThreshold, 'lowCreditThreshold');

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
