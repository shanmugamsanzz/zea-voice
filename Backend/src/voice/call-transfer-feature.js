import { env } from '../config/env.js';

export function isCallTransferEnabledForAgent(agentId, configuration = env) {
  if (configuration.CALL_TRANSFER_ENABLED !== true || !agentId) return false;
  const agents = String(configuration.CALL_TRANSFER_AGENT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return agents.includes(agentId);
}
