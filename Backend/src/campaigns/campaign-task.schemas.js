import{z}from'zod';
export const batchImportSchema=z.object({fileName:z.string().trim().min(1).max(240),csvText:z.string().min(1).max(1_000_000)}).strict();
export const realtimeTaskSchema=z.object({eventId:z.string().trim().min(1).max(200),phone:z.string().trim().min(7).max(40),name:z.string().trim().max(240).optional(),remarks:z.string().trim().max(5000).optional(),context:z.record(z.string(),z.unknown()).default({})}).strict();
export const taskIdSchema=z.object({taskId:z.string().uuid()});
export const listTasksSchema=z.object({source:z.enum(['batch','realtime']).optional(),status:z.enum(['queued','running','paused','completed','failed','busy','no_answer','rejected','unavailable','canceled','archived']).optional(),search:z.string().trim().max(200).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(20)});
export function parseCampaignTaskInput(s,v){const r=s.safeParse(v);if(r.success)return{success:true,data:r.data};return{success:false,issues:r.error.issues.map(i=>({field:i.path.join('.'),message:i.message}))};}
