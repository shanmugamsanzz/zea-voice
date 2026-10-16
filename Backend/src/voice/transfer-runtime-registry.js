// Only retained call-control objects live here. Credentials never enter this registry.
// A resumed stream must reach the process that owns the existing call lease.
export const transferRuntimes = new Map();

export async function notifyVerifiedTransferHangup(providerCallId, tenantId) {
  const entry = [...transferRuntimes.values()].find(value => value.call.providerCallId === providerCallId
    && value.call.tenantId === tenantId);
  if (entry) await entry.hangup();
}
