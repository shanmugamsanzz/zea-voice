import type { UserRole } from '../types';

export const companyTabs = [
  ['dashboard', 'Dashboard'], ['analytics', 'Analytics'], ['campaigns', 'Campaigns'],
  ['queue-monitor', 'Call Queue'], ['conversations', 'Conversations'], ['agents', 'Agents'],
  ['reports', 'Reports'], ['vqa-voice', 'VQA Voice'], ['call-logs', 'Call Logs Analytics'],
  ['ai-insights', 'AI Insights'], ['phone-numbers', 'Phone Numbers'],
  ['integrations', 'Integrations'], ['api-keys', 'API Keys'], ['settings', 'Settings'],
] as const;
export function canAccessTab(role: UserRole, access: string[] | null, view: string) {
  if (role === 'SUPER_ADMIN') return true;
  const tab = view.split('/')[0];
  if (!companyTabs.some(([id]) => id === tab)) return false;
  if (role === 'USER' && ['integrations', 'api-keys', 'settings'].includes(tab)) return false;
  return access === null || access.includes(tab);
}
