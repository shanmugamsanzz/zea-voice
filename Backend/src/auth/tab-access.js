import { AppError } from '../middleware/errors.js';

export const companyTabs = Object.freeze(['dashboard', 'analytics', 'campaigns', 'queue-monitor',
  'conversations', 'agents', 'reports', 'vqa-voice', 'call-logs', 'ai-insights',
  'phone-numbers', 'integrations', 'api-keys', 'settings']);

export function hasTabAccess(auth, tab) {
  if (auth.role === 'COMPANY_USER' && ['integrations', 'api-keys', 'settings'].includes(tab)) return false;
  return auth.role === 'SUPER_ADMIN'
    || auth.tabAccess == null || auth.tabAccess.includes(tab);
}

// Shared read-only lookups support enabled screens without enabling management.
export function requestTabs(request) {
  const base = request.baseUrl;
  const path = request.path.replace(/\/+$/u, '') || '/';
  if (base === '/dashboard') return [path === '/analytics' ? 'analytics' : 'dashboard'];
  if (base === '/agents' && request.method === 'GET' && path === '/') {
    return ['agents', 'campaigns', 'reports', 'vqa-voice'];
  }
  if (base === '/phone-numbers' && request.method === 'GET') return ['phone-numbers', 'agents', 'campaigns'];
  if (base === '/campaigns' && request.method === 'GET' && path === '/') return ['campaigns', 'reports'];
  if (base === '/calls') return ['reports', 'call-logs', 'conversations', 'vqa-voice'];
  const tabs = {
    '/agents': ['agents'], '/catalog': ['agents'], '/pronunciation-groups': ['agents'],
    '/ambience-assets': ['agents'], '/campaigns': ['campaigns'], '/queues': ['queue-monitor'],
    '/conversations': ['conversations'], '/vqa': ['vqa-voice'], '/insights': ['ai-insights'],
    '/phone-numbers': ['phone-numbers'], '/api-keys': ['api-keys'],
    '/settings': ['settings'], '/users': ['settings'], '/api/public': ['campaigns'],
  };
  return tabs[base] ?? [];
}

export function assertRequestTabAccess(request) {
  const tabs = requestTabs(request);
  if (tabs.length && !tabs.some(tab => hasTabAccess(request.auth, tab))) {
    throw new AppError(403, 'This section is disabled for your account', 'TAB_ACCESS_DENIED');
  }
}
