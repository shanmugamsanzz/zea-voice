import { z } from 'zod';
export const resourceAgentIdSchema=z.object({agentId:z.string().uuid()});
export const resourceIdSchema=z.object({resourceId:z.string().uuid()});
export const agentKnowledgeBaseParamsSchema=z.object({agentId:z.string().uuid(),knowledgeBaseId:z.string().uuid().optional()});
export const assignAgentKnowledgeBaseSchema=z.object({usageDirection:z.enum(['inbound','outbound','both']).optional(),priority:z.number().int().min(0).max(100000).default(100)}).strict();
const toolInputPropertySchema=z.object({type:z.enum(['string','number','integer','boolean','array','object']).optional()}).passthrough();
const toolInputSchema=z.object({
  type:z.literal('object').default('object'),
  properties:z.record(z.string(),toolInputPropertySchema).default({}),
  required:z.array(z.string().min(1).max(160)).max(50).default([]),
  additionalProperties:z.boolean().default(true),
}).passthrough().refine((value)=>Object.keys(value.properties).length<=50,'Tool input schema cannot exceed 50 properties');
const webhookToolConfigurationSchema=z.object({
  version:z.literal(1).default(1),
  url:z.string().trim().url().max(2048),
  method:z.enum(['POST','PUT','PATCH']).default('POST'),
  timeoutMs:z.number().int().min(1000).max(30000).default(15000),
  headers:z.record(z.string(),z.string()).default({}),
  inputSchema:toolInputSchema.default({type:'object',properties:{},required:[],additionalProperties:true}),
  responseMode:z.literal('synchronous').default('synchronous'),
}).strict();
const secretToolConfigurationSchema=z.union([
  z.object({headers:z.record(z.string(),z.string())}).strict(),
  z.record(z.string(),z.string()),
]);
const commonToolFields={name:z.string().trim().min(1).max(160).refine((value)=>/[a-zA-Z0-9]/.test(value),'Tool identifier must contain a letter or number'),description:z.string().trim().max(5000).nullable().optional(),status:z.enum(['active','inactive']).default('active'),secretConfiguration:secretToolConfigurationSchema.optional()};
export const createToolSchema=z.discriminatedUnion('type',[
  z.object({...commonToolFields,type:z.literal('webhook_api'),configuration:webhookToolConfigurationSchema.default({})}),
  z.object({...commonToolFields,type:z.enum(['calcom','hubspot','salesforce']),configuration:z.record(z.string(),z.unknown()).default({})}),
]);
export const testToolSchema=z.object({arguments:z.record(z.string(),z.unknown()).default({})}).strict();
export const toolStatusSchema=z.object({status:z.enum(['active','inactive'])});
export const createKnowledgeSchema=z.object({displayName:z.string().trim().min(1).max(240),fileName:z.string().trim().min(1).max(240),mimeType:z.enum(['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),sizeBytes:z.number().int().min(1).max(52_428_800),metadata:z.record(z.string(),z.unknown()).default({})});
export const completeUploadSchema=z.object({objectKey:z.string().trim().min(1).max(700),checksumSha256:z.string().regex(/^[a-f0-9]{64}$/i).transform(v=>v.toLowerCase())});
export function parseAgentResourceInput(schema,value){const result=schema.safeParse(value);if(result.success)return{success:true,data:result.data};return{success:false,issues:result.error.issues.map(i=>({field:i.path.join('.'),message:i.message}))};}
