import { z } from 'zod';

const tableName = z.string().trim().min(1).max(160);
const columnName = z.string().trim().min(1).max(160);
const values = z.record(z.string().max(160), z.union([
  z.string().max(10_000), z.number(), z.boolean(), z.null(),
]));
const gridCell = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);

export const liveDataAgentParamsSchema = z.object({ agentId: z.string().uuid() });
export const liveDataTableParamsSchema = z.object({ agentId: z.string().uuid(), tableId: z.string().uuid() });
export const liveDataColumnParamsSchema = z.object({ agentId: z.string().uuid(), tableId: z.string().uuid(), columnId: z.string().uuid() });
export const liveDataRowParamsSchema = z.object({ agentId: z.string().uuid(), tableId: z.string().uuid(), rowId: z.string().uuid() });
export const createLiveDataTableSchema = z.object({ name: tableName }).strict();
export const updateLiveDataTableSchema = z.object({ name: tableName }).strict();
export const createLiveDataColumnSchema = z.object({
  name: columnName,
  dataType: z.enum(['text', 'number', 'date', 'boolean']).default('text'),
}).strict();
export const updateLiveDataColumnSchema = z.object({
  name: columnName.optional(),
  dataType: z.enum(['text', 'number', 'date', 'boolean']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one column field is required');
export const createLiveDataRowSchema = z.object({ values: values.default({}) }).strict();
export const updateLiveDataRowSchema = z.object({ values }).strict();
export const replaceLiveDataGridSchema = z.object({
  columns: z.array(z.object({
    name: columnName,
    dataType: z.enum(['text', 'number', 'date', 'boolean']).default('text'),
  }).strict()).max(100),
  rows: z.array(z.array(gridCell).max(100)).max(1_000),
}).strict();

export function parseLiveDataInput(schema, input) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data };
  return {
    success: false,
    issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  };
}
