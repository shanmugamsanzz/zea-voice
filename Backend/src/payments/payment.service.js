import crypto from 'node:crypto';
import { AppError } from '../middleware/errors.js';
import { withPlatformAdminContext, withTenantContext } from '../infrastructure/database-context.js';

const number = (value) => Number(value);
function mapPayment(row) {
  return {
    id: row.id, transactionReference: row.transaction_reference,
    externalReference: row.external_reference, companyId: row.tenant_id,
    workspaceId: row.workspace_id, companyName: row.company_name,
    type: row.type, status: row.status, amount: number(row.amount), currency: row.currency,
    paymentMethod: row.payment_method_label, invoiceNumber: row.invoice_number,
    invoiceAvailable: Boolean(row.invoice_object_key), settledAt: row.settled_at,
    failureCode: row.failure_code, failureMessage: row.failure_message,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
const select = `SELECT count(*) OVER()::int AS full_count, p.*, o.name AS company_name FROM payment_transactions p
  JOIN organizations o ON o.tenant_id = p.tenant_id AND o.deleted_at IS NULL`;

function contextFor(auth, operation) {
  return auth.role === 'SUPER_ADMIN'
    ? withPlatformAdminContext(auth.userId, operation)
    : withTenantContext(auth, operation);
}

export function listPayments(auth, filters) {
  return contextFor(auth, async (client) => {
    const companyId = auth.role === 'SUPER_ADMIN' ? filters.companyId ?? null : auth.tenantId;
    const values = [companyId, filters.type ?? null, filters.status ?? null];
    const where = `WHERE ($1::uuid IS NULL OR p.tenant_id = $1)
      AND ($2::payment_type IS NULL OR p.type = $2)
      AND ($3::payment_status IS NULL OR p.status = $3)`;
    const offset = (filters.page - 1) * filters.pageSize;
    const rows = await client.query(`${select} ${where} ORDER BY p.created_at DESC LIMIT $4 OFFSET $5`,
      [...values, filters.pageSize, offset]);
    const total = rows.rows[0]?.full_count ?? 0;
    return { items: rows.rows.map(mapPayment), pagination: {
      page: filters.page, pageSize: filters.pageSize, total,
      totalPages: Math.ceil(total / filters.pageSize),
    } };
  });
}

export function getPaymentSummary(actorUserId) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const result = await client.query(`SELECT currency,
      COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'), 0) AS succeeded_amount,
      count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      count(*) FILTER (WHERE status = 'failed')::int AS failed_count
      FROM payment_transactions GROUP BY currency ORDER BY currency`);
    return result.rows.map((row) => ({ currency: row.currency,
      succeededAmount: number(row.succeeded_amount), succeededCount: row.succeeded_count,
      pendingCount: row.pending_count, failedCount: row.failed_count }));
  });
}

export function createPayment(actorUserId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const company = await client.query(`SELECT t.id, s.default_workspace_id, o.name AS company_name FROM tenants t
      JOIN tenant_settings s ON s.tenant_id = t.id
      JOIN organizations o ON o.tenant_id = t.id AND o.deleted_at IS NULL
      WHERE t.id = $1 AND t.deleted_at IS NULL`, [input.companyId]);
    if (!company.rowCount) throw new AppError(404, 'Company was not found', 'COMPANY_NOT_FOUND');
    const transactionReference = `pay_${crypto.randomBytes(12).toString('hex')}`;
    try {
      const result = await client.query(`INSERT INTO payment_transactions
        (tenant_id, workspace_id, transaction_reference, external_reference, type, status,
         amount, currency, payment_method_label, invoice_number, invoice_object_key,
         settled_at, failure_code, failure_message, created_by)
        VALUES ($1,$2,$3,$4,$5,$6::payment_status,$7,$8,$9,$10,$11,
          CASE WHEN $6::payment_status = 'succeeded' THEN now() ELSE NULL END,$12,$13,$14) RETURNING *`, [
        input.companyId, company.rows[0].default_workspace_id, transactionReference,
        input.externalReference ?? null, input.type, input.status, input.amount, input.currency,
        input.paymentMethodLabel ?? null, input.invoiceNumber ?? null, input.invoiceObjectKey ?? null,
        input.failureCode ?? null, input.failureMessage ?? null, actorUserId,
      ]);
      await client.query(`INSERT INTO audit_logs
        (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, after_data)
        VALUES ($1,$2,$3,'user','PAYMENT_RECORDED','payment_transaction',$4,$5::jsonb)`,
      [input.companyId, company.rows[0].default_workspace_id, actorUserId, result.rows[0].id,
        JSON.stringify({ transactionReference, type: input.type, status: input.status, amount: input.amount, currency: input.currency })]);
      return mapPayment({ ...result.rows[0], company_name: company.rows[0].company_name });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Payment reference already exists', 'PAYMENT_REFERENCE_EXISTS');
      throw error;
    }
  });
}

export function updatePaymentStatus(actorUserId, paymentId, input) {
  return withPlatformAdminContext(actorUserId, async (client) => {
    const existing = await client.query('SELECT * FROM payment_transactions WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!existing.rowCount) throw new AppError(404, 'Payment was not found', 'PAYMENT_NOT_FOUND');
    const currentStatus = existing.rows[0].status;
    const allowedTransitions = {
      pending: ['succeeded', 'failed'],
      succeeded: ['refunded'],
      failed: [],
      refunded: [],
    };
    if (input.status !== currentStatus && !allowedTransitions[currentStatus].includes(input.status)) {
      throw new AppError(409, `Payment cannot move from ${currentStatus} to ${input.status}`,
        'INVALID_PAYMENT_STATUS_TRANSITION');
    }
    const result = await client.query(`UPDATE payment_transactions SET status = $2::payment_status,
      settled_at = CASE WHEN $2::payment_status = 'succeeded' THEN COALESCE(settled_at, now()) ELSE settled_at END,
      failure_code = CASE WHEN $2::payment_status = 'failed' THEN $3 ELSE NULL END,
      failure_message = CASE WHEN $2::payment_status = 'failed' THEN $4 ELSE NULL END
      WHERE id = $1 RETURNING *`, [paymentId, input.status,
      input.failureCode ?? null, input.failureMessage ?? null]);
    const row = result.rows[0];
    await client.query(`INSERT INTO audit_logs
      (tenant_id, workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data)
      VALUES ($1,$2,$3,'user','PAYMENT_STATUS_CHANGED','payment_transaction',$4,$5::jsonb,$6::jsonb)`,
    [row.tenant_id, row.workspace_id, actorUserId, paymentId,
      JSON.stringify({ status: existing.rows[0].status }), JSON.stringify({ status: row.status })]);
    const company = await client.query('SELECT name FROM organizations WHERE tenant_id = $1 AND deleted_at IS NULL', [row.tenant_id]);
    return mapPayment({ ...row, company_name: company.rows[0]?.name });
  });
}
