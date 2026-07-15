import { z } from 'zod';
export const resourceAgentIdSchema=z.object({agentId:z.string().uuid()});
export const resourceIdSchema=z.object({resourceId:z.string().uuid()});
export const createToolSchema=z.object({name:z.string().trim().min(1).max(160),type:z.enum(['webhook_api','calcom','hubspot','salesforce']),description:z.string().trim().max(5000).nullable().optional(),status:z.enum(['active','inactive']).default('active'),configuration:z.record(z.string(),z.unknown()).default({}),secretConfiguration:z.record(z.string(),z.string()).optional()});
export const toolStatusSchema=z.object({status:z.enum(['active','inactive'])});
export const createKnowledgeSchema=z.object({displayName:z.string().trim().min(1).max(240),fileName:z.string().trim().min(1).max(240),mimeType:z.enum(['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document']),sizeBytes:z.number().int().min(1).max(52_428_800),metadata:z.record(z.string(),z.unknown()).default({})});
export const completeUploadSchema=z.object({objectKey:z.string().trim().min(1).max(700),checksumSha256:z.string().regex(/^[a-f0-9]{64}$/i).transform(v=>v.toLowerCase())});
export function parseAgentResourceInput(schema,value){const result=schema.safeParse(value);if(result.success)return{success:true,data:result.data};return{success:false,issues:result.error.issues.map(i=>({field:i.path.join('.'),message:i.message}))};}
