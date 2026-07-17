import { AppError } from '../middleware/errors.js';
import { authenticateAccessToken } from './auth.service.js';
import { authenticateApiKey, isApiKeyToken } from '../api-keys/api-key.service.js';
import { isPlatformAdminIpAllowed } from '../settings/platform-setting.service.js';

export function extractBearerToken(request) {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

function requiredApiKeyScope(request) {
  const resourceByBaseUrl = {
    '/admin/companies': 'companies',
    '/admin/developers': 'developers',
    '/admin/providers': 'providers',
    '/catalog': 'providers',
    '/admin/telephony': 'phone_numbers',
    '/phone-numbers': 'phone_numbers',
    '/admin/credits': 'credits',
    '/credits': 'credits',
    '/admin/queues': 'queues',
    '/admin/payments': 'payments',
    '/payments': 'payments',
    '/admin/settings': 'settings',
    '/dashboard': 'dashboard',
    '/users': 'users',
    '/agents': 'agents',
    '/campaigns': 'campaigns',
    '/knowledge-bases': 'knowledge_bases',
    '/calls': 'calls',
    '/reports': 'reports',
  };
  const resource = resourceByBaseUrl[request.baseUrl];
  if (!resource) return null;
  if (resource === 'calls' && request.method === 'POST') return 'calls:create';
  return `${resource}:${request.method === 'GET' ? 'read' : 'write'}`;
}

export async function authenticateRequest(request, _response, next) {
  try {
    const token = extractBearerToken(request);
    if (!token) throw new AppError(401, 'Authentication is required', 'UNAUTHENTICATED');
    request.auth = isApiKeyToken(token)
      ? await authenticateApiKey(token, { ipAddress: request.ip ?? null })
      : await authenticateAccessToken(token);
    const requiredScope = request.auth.authType === 'api_key' ? requiredApiKeyScope(request) : null;
    if (requiredScope && !request.auth.scopes.includes('*') && !request.auth.scopes.includes(requiredScope)) {
      throw new AppError(403, 'API key does not have the required scope', 'API_KEY_SCOPE_REQUIRED', {
        requiredScopes: [requiredScope],
      });
    }
    if (request.auth.role === 'SUPER_ADMIN'
      && !await isPlatformAdminIpAllowed(request.ip ?? '127.0.0.1')) {
      throw new AppError(403, 'Administrative access is not allowed from this IP address', 'ADMIN_IP_NOT_ALLOWED');
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function requireSessionAuthentication(request, _response, next) {
  if (request.auth?.authType === 'api_key') {
    next(new AppError(403, 'This operation requires an interactive user session', 'SESSION_REQUIRED'));
    return;
  }
  next();
}

export function requireScopes(...requiredScopes) {
  return (request, _response, next) => {
    if (request.auth?.authType !== 'api_key' || request.auth.scopes?.includes('*')
      || requiredScopes.some((scope) => request.auth.scopes?.includes(scope))) {
      next();
      return;
    }
    next(new AppError(403, 'API key does not have the required scope', 'API_KEY_SCOPE_REQUIRED', {
      requiredScopes,
    }));
  };
}

export function requireRoles(...allowedRoles) {
  return (request, _response, next) => {
    if (!request.auth) {
      next(new AppError(401, 'Authentication is required', 'UNAUTHENTICATED'));
      return;
    }
    if (!allowedRoles.includes(request.auth.role)) {
      next(new AppError(403, 'You do not have permission to perform this action', 'FORBIDDEN'));
      return;
    }
    next();
  };
}
