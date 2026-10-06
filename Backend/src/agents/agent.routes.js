import { Router } from 'express';
import { authenticateRequest, requireRoles, requireSessionAuthentication } from '../auth/auth.middleware.js';
import { requireTenantContext } from '../auth/tenant.middleware.js';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { agentIdSchema, agentStatusSchema, createAgentSchema, listAgentsSchema, parseAgentInput, updateAgentSchema } from './agent.schemas.js';
import { archiveAgent, createAgent, getAgent, listAgents, updateAgent } from './agent.service.js';
import { agentResourceRouter } from './agent-resource.routes.js';
import { z } from 'zod';
import { startAgentPhoneTest } from './agent-phone-test.service.js';
import { getPhoneTestRequest } from './agent-phone-test-queue.service.js';
import { createPhoneTestShareLink,listPhoneTestShareLinks,revokePhoneTestShareLink } from './phone-test-share-link.service.js';
function valid(schema,value){const parsed=parseAgentInput(schema,value);if(!parsed.success)throw new AppError(400,'Request validation failed','VALIDATION_ERROR',parsed.issues);return parsed.data;}
function auth(req){return{...req.auth,tenantId:req.tenant.tenantId,workspaceId:req.tenant.workspaceId};}
const writers=requireRoles('SUPER_ADMIN','COMPANY_DEVELOPER');
export const agentRouter=Router(); agentRouter.use(authenticateRequest,requireTenantContext);
agentRouter.get('/configuration',(_req,res)=>res.json({success:true,data:{limits:{systemPromptMaxCharacters:env.LLM_SYSTEM_PROMPT_MAX_CHARS}}}));
agentRouter.use('/:agentId',agentResourceRouter);
agentRouter.post('/:agentId/phone-test-share-links',writers,requireSessionAuthentication,async(req,res)=>{
  const {agentId}=valid(agentIdSchema,req.params);
  const input=valid(z.object({expiresIn:z.enum(['24h','permanent'])}).strict(),req.body);
  res.set('Cache-Control','no-store').status(201).json({success:true,data:await createPhoneTestShareLink(auth(req),agentId,input)});
});
agentRouter.get('/:agentId/phone-test-share-links',writers,requireSessionAuthentication,async(req,res)=>{
  const {agentId}=valid(agentIdSchema,req.params);
  res.set('Cache-Control','no-store').json({success:true,data:await listPhoneTestShareLinks(auth(req),agentId)});
});
agentRouter.delete('/:agentId/phone-test-share-links/:linkId',writers,requireSessionAuthentication,async(req,res)=>{
  const {agentId,linkId}=valid(z.object({agentId:z.string().uuid(),linkId:z.string().uuid()}),req.params);
  res.set('Cache-Control','no-store').json({success:true,data:await revokePhoneTestShareLink(auth(req),agentId,linkId)});
});
agentRouter.post('/:agentId/phone-test-calls',writers,async(req,res)=>{
  const {agentId}=valid(agentIdSchema,req.params);
  const input=valid(z.object({phone:z.string().trim().min(7).max(40),requestId:z.string().uuid().optional()}).strict(),req.body);
  res.status(201).json({success:true,data:await startAgentPhoneTest(auth(req),agentId,input)});
});
agentRouter.get('/:agentId/phone-test-calls/:requestId',async(req,res)=>{
  const {agentId,requestId}=valid(z.object({agentId:z.string().uuid(),requestId:z.string().uuid()}),req.params);
  res.json({success:true,data:await getPhoneTestRequest(auth(req),requestId,agentId)});
});
agentRouter.get('/',async(req,res)=>res.json({success:true,data:await listAgents(auth(req),valid(listAgentsSchema,req.query))}));
agentRouter.get('/:agentId',async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await getAgent(auth(req),agentId)});});
agentRouter.post('/',writers,async(req,res)=>res.status(201).json({success:true,data:await createAgent(auth(req),valid(createAgentSchema,req.body))}));
agentRouter.put('/:agentId',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await updateAgent(auth(req),agentId,valid(updateAgentSchema,req.body))});});
agentRouter.patch('/:agentId/status',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await updateAgent(auth(req),agentId,valid(agentStatusSchema,req.body))});});
agentRouter.delete('/:agentId',writers,async(req,res)=>{const{agentId}=valid(agentIdSchema,req.params);res.json({success:true,data:await archiveAgent(auth(req),agentId)});});
