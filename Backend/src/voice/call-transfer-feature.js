import { env } from '../config/env.js';

export function isCallTransferEnabledForAgent(agentId, configuration = env) {
  return configuration.CALL_TRANSFER_ENABLED === true && Boolean(agentId);
}
