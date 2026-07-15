import { Router } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../middleware/errors.js';
import { authenticateRequest, extractBearerToken } from './auth.middleware.js';
import { requireTenantContext } from './tenant.middleware.js';
import { parseRequest, loginSchema, refreshSchema } from './auth.schemas.js';
import { login, logoutSession, refreshSession } from './auth.service.js';

export const authRouter = Router();

const refreshCookieOptions = {
  httpOnly: true,
  secure: env.AUTH_COOKIE_SECURE,
  sameSite: 'strict',
  path: '/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
};

function clientMetadata(request) {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
  };
}

function requireValidBody(schema, body) {
  const parsed = parseRequest(schema, body);
  if (!parsed.success) {
    throw new AppError(400, 'Request validation failed', 'VALIDATION_ERROR', parsed.issues);
  }
  return parsed.data;
}

authRouter.post('/login', async (request, response) => {
  const input = requireValidBody(loginSchema, request.body);
  const result = await login({ ...input, ...clientMetadata(request) });
  response.cookie(env.REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions);
  const { refreshToken: _refreshToken, ...body } = result;
  response.status(200).json({ success: true, data: body });
});

authRouter.post('/refresh', async (request, response) => {
  const input = requireValidBody(refreshSchema, request.body ?? {});
  const refreshToken = input.refreshToken ?? request.cookies?.[env.REFRESH_COOKIE_NAME];
  if (!refreshToken) throw new AppError(401, 'Refresh token is required', 'INVALID_REFRESH_TOKEN');

  const result = await refreshSession(refreshToken, clientMetadata(request));
  response.cookie(env.REFRESH_COOKIE_NAME, result.refreshToken, refreshCookieOptions);
  const { refreshToken: _refreshToken, ...body } = result;
  response.status(200).json({ success: true, data: body });
});

authRouter.post('/logout', async (request, response) => {
  const accessToken = extractBearerToken(request);
  const refreshToken = request.cookies?.[env.REFRESH_COOKIE_NAME] ?? request.body?.refreshToken;
  await logoutSession({ accessToken, refreshToken });
  response.clearCookie(env.REFRESH_COOKIE_NAME, refreshCookieOptions);
  response.status(204).send();
});

authRouter.get('/me', authenticateRequest, (request, response) => {
  response.json({ success: true, data: { user: request.auth } });
});

authRouter.get('/context', authenticateRequest, requireTenantContext, (request, response) => {
  response.json({ success: true, data: request.tenant });
});
