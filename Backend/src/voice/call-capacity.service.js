import { voiceCallOwnership } from './call-ownership.service.js';

// Covers provider request time and the bounded ringing period. Active media
// switches to the existing short lease and heartbeat recovery mechanism.
export const outboundReservationTtlSeconds = 300;
export const outboundRingTimeoutSeconds = 120;

export function capacityCallbackUrl(baseUrl, reservationId) {
  const url = new URL(baseUrl);
  url.searchParams.set('capacity_id', reservationId);
  return url.toString();
}

export async function admitAnsweredCall({ tenantId, providerCallId, limit, reservationId },
  ownership = voiceCallOwnership) {
  if (reservationId) {
    const binding = await ownership.bindReservation({ tenantId, reservationId, providerCallId,
      ttlSeconds: outboundReservationTtlSeconds });
    if (binding.bound) return binding;
  }
  return ownership.acquire({ tenantId, providerCallId, limit, ttlSeconds: outboundReservationTtlSeconds });
}
