import { Router } from 'express';
import { requireRoles } from '../auth/auth.middleware.js';
import { AppError } from '../middleware/errors.js';
import {
  createLiveDataColumnSchema, createLiveDataRowSchema, createLiveDataTableSchema,
  liveDataAgentParamsSchema, liveDataColumnParamsSchema, liveDataRowParamsSchema,
  liveDataTableParamsSchema, parseLiveDataInput, updateLiveDataColumnSchema,
  updateLiveDataRowSchema, updateLiveDataTableSchema, replaceLiveDataGridSchema,
} from './agent-live-data.schemas.js';
import {
  createLiveDataColumn, createLiveDataRow, createLiveDataTable, deleteLiveDataColumn,
  deleteLiveDataRow, deleteLiveDataTable, listLiveDataHistory, listLiveDataTables, updateLiveDataColumn,
  updateLiveDataRow, updateLiveDataTable, replaceLiveDataGrid,
} from './agent-live-data.service.js';

function valid(schema, value) {
  const parsed = parseLiveDataInput(schema, value);
  if (!parsed.success) throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  return parsed.data;
}
function auth(request) { return { ...request.auth, tenantId: request.tenant.tenantId, workspaceId: request.tenant.workspaceId }; }
const write = requireRoles('SUPER_ADMIN', 'COMPANY_DEVELOPER', 'COMPANY_USER');

export const agentLiveDataRouter = Router({ mergeParams: true });
agentLiveDataRouter.get('/tables', async (request, response) => {
  const { agentId } = valid(liveDataAgentParamsSchema, request.params);
  response.json({ success: true, data: await listLiveDataTables(auth(request), agentId) });
});
agentLiveDataRouter.get('/tables/:tableId/history', async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.json({ success: true, data: await listLiveDataHistory(auth(request), agentId, tableId) });
});
agentLiveDataRouter.post('/tables', write, async (request, response) => {
  const { agentId } = valid(liveDataAgentParamsSchema, request.params);
  response.status(201).json({ success: true, data: await createLiveDataTable(auth(request), agentId, valid(createLiveDataTableSchema, request.body)) });
});
agentLiveDataRouter.put('/tables/:tableId', write, async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.json({ success: true, data: await updateLiveDataTable(auth(request), agentId, tableId, valid(updateLiveDataTableSchema, request.body)) });
});
agentLiveDataRouter.put('/tables/:tableId/grid', write, async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.json({ success: true, data: await replaceLiveDataGrid(auth(request), agentId, tableId, valid(replaceLiveDataGridSchema, request.body)) });
});
agentLiveDataRouter.delete('/tables/:tableId', write, async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.json({ success: true, data: await deleteLiveDataTable(auth(request), agentId, tableId) });
});
agentLiveDataRouter.post('/tables/:tableId/columns', write, async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.status(201).json({ success: true, data: await createLiveDataColumn(auth(request), agentId, tableId, valid(createLiveDataColumnSchema, request.body)) });
});
agentLiveDataRouter.put('/tables/:tableId/columns/:columnId', write, async (request, response) => {
  const { agentId, tableId, columnId } = valid(liveDataColumnParamsSchema, request.params);
  response.json({ success: true, data: await updateLiveDataColumn(auth(request), agentId, tableId, columnId, valid(updateLiveDataColumnSchema, request.body)) });
});
agentLiveDataRouter.delete('/tables/:tableId/columns/:columnId', write, async (request, response) => {
  const { agentId, tableId, columnId } = valid(liveDataColumnParamsSchema, request.params);
  response.json({ success: true, data: await deleteLiveDataColumn(auth(request), agentId, tableId, columnId) });
});
agentLiveDataRouter.post('/tables/:tableId/rows', write, async (request, response) => {
  const { agentId, tableId } = valid(liveDataTableParamsSchema, request.params);
  response.status(201).json({ success: true, data: await createLiveDataRow(auth(request), agentId, tableId, valid(createLiveDataRowSchema, request.body)) });
});
agentLiveDataRouter.put('/tables/:tableId/rows/:rowId', write, async (request, response) => {
  const { agentId, tableId, rowId } = valid(liveDataRowParamsSchema, request.params);
  response.json({ success: true, data: await updateLiveDataRow(auth(request), agentId, tableId, rowId, valid(updateLiveDataRowSchema, request.body)) });
});
agentLiveDataRouter.delete('/tables/:tableId/rows/:rowId', write, async (request, response) => {
  const { agentId, tableId, rowId } = valid(liveDataRowParamsSchema, request.params);
  response.json({ success: true, data: await deleteLiveDataRow(auth(request), agentId, tableId, rowId) });
});
