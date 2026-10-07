import { Router } from 'express';
import { z } from 'zod';
import { authenticateRequest, requireRoles, requireScopes, requireSessionAuthentication } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { listConversations,getConversation,getConversationTranscript } from './conversation-view.service.js';
import { conversationScope } from './conversation-view.service.js';
import { cancelFollowUp } from './follow-up.service.js';
import { withTenantContext,withPlatformAdminContext } from '../infrastructure/database-context.js';

const query=z.object({companyId:z.string().uuid().optional(),search:z.string().trim().max(120).optional(),
  page:z.coerce.number().int().min(1).max(100000).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(25),
  followUpPage:z.coerce.number().int().min(1).max(100000).default(1)}).strict();
const params=z.object({conversationId:z.string().uuid(),callId:z.string().uuid().optional()});
const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)throw new AppError(400,'Request validation failed','VALIDATION_ERROR');return result.data;};
function routes(router){
  router.post('/:conversationId/follow-ups/:taskId/cancel',requireRoles('SUPER_ADMIN','COMPANY_DEVELOPER'),requireSessionAuthentication,async(req,res)=>{
    const ids=parse(z.object({conversationId:z.string().uuid(),taskId:z.string().uuid()}),req.params);
    const scope=conversationScope(req.auth,parse(query,req.query).companyId);
    const operation=client=>cancelFollowUp(client,{...scope,userId:req.auth.userId,conversationId:ids.conversationId},ids.taskId);
    const data=await (req.auth.role==='SUPER_ADMIN'?withPlatformAdminContext(req.auth.userId,operation):withTenantContext(req.auth,operation));
    res.json({success:true,data});
  });
  router.get('/',async(req,res)=>res.json({success:true,data:await listConversations(req.auth,parse(query,req.query))}));
  router.get('/:conversationId',async(req,res)=>{
    const ids=parse(params,req.params);
    res.json({success:true,data:await getConversation(req.auth,ids.conversationId,parse(query,req.query))});
  });
  router.get('/:conversationId/calls/:callId/transcript',async(req,res)=>{
    const ids=parse(params,req.params);
    res.json({success:true,data:await getConversationTranscript(req.auth,ids.conversationId,ids.callId,parse(query,req.query))});
  });
}
export const conversationRouter=Router();
conversationRouter.use(authenticateRequest,requireRoles('COMPANY_USER','COMPANY_DEVELOPER'),requireScopes('calls:read'),requireTenantContext);
routes(conversationRouter);
export const adminConversationRouter=Router();
adminConversationRouter.use(authenticateRequest,requireRoles('SUPER_ADMIN'),requireScopes('calls:read'));
routes(adminConversationRouter);
