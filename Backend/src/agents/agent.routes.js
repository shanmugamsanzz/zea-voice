import { Router } from 'express';
import { authenticateRequest, requireRoles } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { AppError } from '../middleware/errors.js';
import { agentIdSchema, agentStatusSchema, createAgentSchema, listAgentsSchema, parseAgentInput, updateAgentSchema } from './agent.schemas.js';
import { archiveAgent, createAgent, getAgent, listAgents, updateAgent } from './agent.service.js';
import { agentResourceRouter } from './agent-resource.routes.js';
function valid(schema,value){const parsed=parseAgentInput(schema,value);if(!parsed.success)throw new AppError(400,'Request validation failed','VALIDATION_ERROR',parsed.issues);return parsed.data;}
function auth(req){return{...req.auth,tenantId:req.tenant.tenantId,workspaceId:req.tenant.workspaceId};}
const writers=requireRoles('SUPER_ADMIN','COMPANY_DEVELOPER');
export const agentRouter=Router(); agentRouter.use(authenticateRequest,requireTenantContext);
agentRouter.use('/:agentId',agentResourceRouter);
agentRouter.get('/',async(req,res)=>res.json({success:true,data:await listAgents(auth(req),valid(listAgentsSchema,req.query))}));
agentRouter.get('/:agentId',async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await getAgent(auth(req),agentId)});});
agentRouter.post('/',writers,async(req,res)=>res.status(201).json({success:true,data:await createAgent(auth(req),valid(createAgentSchema,req.body))}));
agentRouter.put('/:agentId',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await updateAgent(auth(req),agentId,valid(updateAgentSchema,req.body))});});
agentRouter.patch('/:agentId/status',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await updateAgent(auth(req),agentId,valid(agentStatusSchema,req.body))});});
agentRouter.delete('/:agentId',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await archiveAgent(auth(req),agentId)});});
