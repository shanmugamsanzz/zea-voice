import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  companyIdSchema,
  companyStatusSchema,
  createCompanySchema,
  listCompaniesSchema,
  parseCompanyInput,
  updateCompanySchema,
} from './company.schemas.js';
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  listCompanyOptions,
  updateCompany,
  updateCompanyStatus,
} from './company.service.js';

export const companyRouter = Router();

companyRouter.use(authenticateRequest, requireRoles('SUPER_ADMIN'));

function valid(schema, value) {
  const parsed = parseCompanyInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}

function metadata(request) {
  return {
    requestId: request.id,
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
  };
}

companyRouter.get('/', async (request, response) => {
  const filters = valid(listCompaniesSchema, request.query);
  response.json({ success: true, data: await listCompanies(request.auth.userId, filters) });
});

companyRouter.get('/options', async (request, response) => {
  response.json({ success: true, data: await listCompanyOptions(request.auth.userId) });
});

companyRouter.post('/', async (request, response) => {
  const input = valid(createCompanySchema, request.body);
  const company = await createCompany(request.auth.userId, input, metadata(request));
  response.status(201).json({ success: true, data: company });
});

companyRouter.get('/:companyId', async (request, response) => {
  const { companyId } = valid(companyIdSchema, request.params);
  response.json({ success: true, data: await getCompany(request.auth.userId, companyId) });
});

companyRouter.patch('/:companyId', async (request, response) => {
  const { companyId } = valid(companyIdSchema, request.params);
  const input = valid(updateCompanySchema, request.body);
  response.json({
    success: true,
    data: await updateCompany(request.auth.userId, companyId, input, metadata(request)),
  });
});

companyRouter.patch('/:companyId/status', async (request, response) => {
  const { companyId } = valid(companyIdSchema, request.params);
  const { status } = valid(companyStatusSchema, request.body);
  response.json({
    success: true,
    data: await updateCompanyStatus(request.auth.userId, companyId, status, metadata(request)),
  });
});

companyRouter.delete('/:companyId', async (request, response) => {
  const { companyId } = valid(companyIdSchema, request.params);
  response.json({
    success: true,
    data: await deleteCompany(request.auth.userId, companyId, metadata(request)),
  });
});
