import assert from 'node:assert/strict';
import {
  CREDIT_ADMISSION_REASON,
  calculateCallCharge,
  convertPaymentToCredits,
  creditsForConnectedDuration,
  evaluateCallCreditAdmission,
  getCompanyCreditStatus,
} from '../src/credits/credit-billing-rules.js';

const durationCases = new Map([
  [0, 0], [1, 1], [33, 1], [60, 1], [61, 2], [226, 4], [302, 6],
]);
for (const [seconds, expectedCredits] of durationCases) {
  assert.equal(creditsForConnectedDuration(seconds), expectedCredits, `${seconds}s billing`);
}

assert.deepEqual(calculateCallCharge({ durationSeconds: 44, perMinutePrice: '6' }), {
  durationSeconds: 44, billedMinutes: 1, credits: 1, chargeAmount: '6', perMinutePrice: '6',
});
assert.deepEqual(calculateCallCharge({ durationSeconds: 61, perMinutePrice: '7' }), {
  durationSeconds: 61, billedMinutes: 2, credits: 2, chargeAmount: '14', perMinutePrice: '7',
});

const firstAllocation = convertPaymentToCredits({ paymentAmount: '10000', perMinutePrice: '7' });
assert.deepEqual(firstAllocation, {
  credits: 1428,
  paymentAmount: '10000',
  previousRemainderAmount: '0',
  totalAvailableAmount: '10000',
  consumedAmount: '9996',
  remainderAmount: '4',
  perMinutePrice: '7',
});

const secondAllocation = convertPaymentToCredits({
  paymentAmount: '10000', perMinutePrice: '7', remainderAmount: firstAllocation.remainderAmount,
});
assert.equal(secondAllocation.credits, 1429);
assert.equal(secondAllocation.remainderAmount, '1');

const decimalRate = convertPaymentToCredits({ paymentAmount: '100', perMinutePrice: '7.5' });
assert.equal(decimalRate.credits, 13);
assert.equal(decimalRate.remainderAmount, '2.5');

const reducedRate = convertPaymentToCredits({
  paymentAmount: '1', perMinutePrice: '3', remainderAmount: '4',
});
assert.equal(reducedRate.credits, 1);
assert.equal(reducedRate.remainderAmount, '2');

assert.equal(getCompanyCreditStatus({ availableCredits: 51, lowCreditThreshold: 50 }), 'available');
assert.equal(getCompanyCreditStatus({ availableCredits: 50, lowCreditThreshold: 50 }), 'low');
assert.equal(getCompanyCreditStatus({ availableCredits: 0, lowCreditThreshold: 50 }), 'exhausted');

assert.deepEqual(evaluateCallCreditAdmission({
  direction: 'outbound', availableCredits: 51, lowCreditThreshold: 50,
}), { allowed: true, reason: CREDIT_ADMISSION_REASON.ALLOWED, status: 'available' });
assert.deepEqual(evaluateCallCreditAdmission({
  direction: 'outbound', availableCredits: 50, lowCreditThreshold: 50,
}), { allowed: false, reason: CREDIT_ADMISSION_REASON.OUTBOUND_THRESHOLD_REACHED, status: 'low' });
assert.deepEqual(evaluateCallCreditAdmission({
  direction: 'inbound', availableCredits: 1, lowCreditThreshold: 50,
}), { allowed: true, reason: CREDIT_ADMISSION_REASON.ALLOWED, status: 'low' });
assert.deepEqual(evaluateCallCreditAdmission({
  direction: 'inbound', availableCredits: 0, lowCreditThreshold: 50,
}), { allowed: false, reason: CREDIT_ADMISSION_REASON.EXHAUSTED, status: 'exhausted' });

assert.throws(() => convertPaymentToCredits({ paymentAmount: '100', perMinutePrice: '0' }), /greater than zero/);
assert.throws(() => convertPaymentToCredits({ paymentAmount: '1.00001', perMinutePrice: '7' }), /four decimal/);
assert.throws(() => evaluateCallCreditAdmission({
  direction: 'outbound', availableCredits: 50.5, lowCreditThreshold: 50,
}), /whole number/);

console.log('Credit billing rules verified successfully.');
