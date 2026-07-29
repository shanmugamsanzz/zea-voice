# Company credit billing rules

This document is the canonical contract for the company credit implementation.

## Units and visibility

- A company wallet stores **whole call credits**, not INR.
- One credit pays for one started connected minute.
- The company per-minute price, payments and INR remainder are visible only to Super Admin.
- Company developers and users see only whole credit balances and credit ledger movements.
- Provider balance monitoring is separate from company billing and remains unchanged.

## Payment conversion

For a company payment:

1. Add the new INR payment to that company's private carried INR remainder.
2. Divide the total by the company's current per-minute price.
3. Issue `floor(total / price)` whole credits.
4. Carry `total - (issued credits * price)` as the company's private INR remainder.
5. Save the price used for the allocation so later price edits cannot rewrite history.

Example: ₹10,000 at ₹7 issues 1,428 credits and carries ₹4. A later ₹10,000 payment uses ₹10,004, issues 1,429 credits and carries ₹1.

All INR calculations use fixed-point decimal arithmetic with four decimal places. Floating-point arithmetic is prohibited for payment conversion.

## Call charging

- Charge only connected call duration.
- `credits = ceil(duration_seconds / 60)` for every duration greater than zero.
- A zero-duration/unconnected call costs zero credits.
- The same company rate and credit rounding apply to inbound and outbound calls.
- Examples: 33s = 1, 60s = 1, 61s = 2, 3m46s = 4, and 5m2s = 6 credits.
- A call debit must be idempotent by call-session ID.
- A call that was admitted may finish even if its debit crosses the configured warning threshold.

The usage ledger's debit amount is measured in **credits**. INR revenue is stored separately as `credits * price_snapshot`; it must never be written into a credit amount or credit balance field.

## Admission and threshold

- The low-credit threshold is one global Super Admin setting and is editable.
- At or below the threshold, new outbound calls, campaigns and public task triggers are blocked.
- Inbound calls remain allowed while at least one credit is available.
- At zero credits, new inbound and outbound AI calls are blocked.
- Active calls are not terminated when the balance or threshold changes.
- Company UI shows a low-credit prompt at or below the threshold and an exhausted prompt at zero.
- Admission atomically reserves one credit so simultaneous calls cannot spend the same balance.
- Lowering the threshold wakes campaign tasks that now have sufficient available credits.
- Finalization releases the reservation and writes the rounded duration debit exactly once.
- An admitted call may finish with a negative balance; all later calls stay blocked until credits are added.

## Tenant and transaction safety

- Every wallet, allocation, remainder and usage debit is tenant-isolated.
- Company credentials and IDs cannot access another company's wallet or ledger.
- Wallet updates and their ledger entries occur in one database transaction with row locking.
- Retries, duplicate Plivo hangups and reconciliation must not charge a call twice.
- Manual adjustments use whole credits and require a Super Admin audit reason.

## Audit findings before implementation

- Existing company wallets, ledger tables and `organizations.per_minute_price` can be reused.
- The current checked-out service adds allocation amounts directly as decimal wallet balance; it does not perform INR-to-credit conversion.
- Tenant credit responses currently include global INR pricing and must be narrowed later.
- Campaign admission currently checks only for a zero balance and does not use the global threshold.
- The checked-out call-completion and reconciliation code does not contain a duration debit path.
- The shared database contains three applied migrations absent from this branch: `1786000000000_company-wallet-credit-units`, `1786100000000_company-credit-price-per-minute`, and `1786200000000_call-credit-billing`.
- Those database changes added a wallet unit, call-session linkage and an idempotent usage-debit index. Preserve those useful constraints, but reconcile their missing migration files before adding any new credit migration.
- Existing usage records reduce wallets by one credit but store an INR value in the ledger amount. Later migration/service work must separate these units without rewriting history silently.
