import crypto from 'node:crypto';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './auth/auth.routes.js';
import { companyRouter } from './companies/company.routes.js';
import { developerRouter } from './developers/developer.routes.js';
import { catalogRouter, providerRouter } from './providers/provider.routes.js';
import { telephonyAdminRouter, tenantPhoneRouter } from './telephony/telephony.routes.js';
import { creditAdminRouter, tenantCreditRouter } from './credits/credit.routes.js';
import { queueAdminRouter } from './queues/queue.routes.js';
import { apiKeyRouter } from './api-keys/api-key.routes.js';
import { callAdminRouter, tenantCallRouter } from './calls/call.routes.js';
import { paymentAdminRouter, tenantPaymentRouter } from './payments/payment.routes.js';
import { platformSettingRouter } from './settings/platform-setting.routes.js';
import { dashboardRouter } from './dashboard/dashboard.routes.js';
import { platformDashboardRouter } from './dashboard/platform-dashboard.routes.js';
import { userRouter } from './users/user.routes.js';
import { agentRouter } from './agents/agent.routes.js';
import { campaignRouter } from './campaigns/campaign.routes.js';
import { knowledgeBaseRouter } from './knowledge-bases/knowledge-base.routes.js';
import { plivoWebhookRouter } from './telephony/plivo-webhook.routes.js';
import { performanceMiddleware } from './middleware/performance.js';
import { voiceRouter } from './voice/voice.routes.js';

function redactRequestUrl(value) {
  if (typeof value !== 'string' || !value.includes('token=')) return value;
  try {
    const parsed = new URL(value, 'http://zea-voice.local');
    if (parsed.searchParams.has('token')) parsed.searchParams.set('token', '[REDACTED]');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return value.replace(/([?&]token=)[^&]*/i, '$1[REDACTED]');
  }
}

function sanitizeLoggedRequest(request) {
  const query = request.query && typeof request.query === 'object'
    ? { ...request.query }
    : request.query;
  if (query && 'token' in query) query.token = '[REDACTED]';
  return { ...request, url: redactRequestUrl(request.url), query };
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin: env.corsOrigins,
    credentials: true,
    exposedHeaders: [
      'server-timing', 'x-request-id', 'x-response-time-ms', 'x-sql-time-ms',
      'x-sql-query-count', 'x-external-time-ms', 'x-external-call-count',
    ],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser());
  app.use(pinoHttp({
    logger,
    serializers: { req: sanitizeLoggedRequest },
    genReqId: (request, response) => {
      const requestId = request.headers['x-request-id']?.toString() ?? crypto.randomUUID();
      response.setHeader('x-request-id', requestId);
      return requestId;
    },
  }));
  app.use(performanceMiddleware);

  app.get('/', (_request, response) => {
    response.json({ success: true, service: 'zea-voice-api', version: '0.1.0' });
  });
  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/admin/companies', companyRouter);
  app.use('/admin/developers', developerRouter);
  app.use('/admin/providers', providerRouter);
  app.use('/catalog', catalogRouter);
  app.use('/admin/telephony', telephonyAdminRouter);
  app.use('/phone-numbers', tenantPhoneRouter);
  app.use('/admin/credits', creditAdminRouter);
  app.use('/credits', tenantCreditRouter);
  app.use('/admin/queues', queueAdminRouter);
  app.use('/api-keys', apiKeyRouter);
  app.use('/admin/calls', callAdminRouter);
  app.use('/calls', tenantCallRouter);
  app.use('/admin/payments', paymentAdminRouter);
  app.use('/payments', tenantPaymentRouter);
  app.use('/admin/settings', platformSettingRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/admin/dashboard', platformDashboardRouter);
  app.use('/users', userRouter);
  app.use('/agents', agentRouter);
  app.use('/campaigns', campaignRouter);
  app.use('/knowledge-bases', knowledgeBaseRouter);
  app.use('/webhooks/plivo', plivoWebhookRouter);
  app.use('/webhooks/plivo', voiceRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
