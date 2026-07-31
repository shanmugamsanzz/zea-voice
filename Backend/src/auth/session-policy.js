export function sessionExpirations(now, { accessTokenTtlMinutes, refreshTokenTtlDays }) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('A valid session start date is required');
  if (!Number.isInteger(accessTokenTtlMinutes) || accessTokenTtlMinutes < 1) {
    throw new TypeError('Access-token TTL must be a positive integer');
  }
  if (!Number.isInteger(refreshTokenTtlDays) || refreshTokenTtlDays < 1) {
    throw new TypeError('Refresh-token TTL must be a positive integer');
  }
  return {
    accessExpiresAt: new Date(now.getTime() + accessTokenTtlMinutes * 60_000),
    refreshExpiresAt: new Date(now.getTime() + refreshTokenTtlDays * 86_400_000),
  };
}
