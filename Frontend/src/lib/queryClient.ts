import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: 0 },
  },
});

const LIVE_PATHS = ['/admin/queues', '/admin/calls', '/calls'];

export function isLiveApiPath(path: string) {
  const pathname = path.split('?')[0];
  return LIVE_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function apiStaleTime(path: string) {
  const pathname = path.split('?')[0];
  if (pathname === '/admin/credits/provider-balances') return 60_000;
  if (pathname === '/admin/settings') return 5 * 60_000;
  if (pathname === '/admin/dashboard') return 15_000;
  return 30_000;
}

export function apiQueryKey(path: string, headers?: Headers) {
  return [
    'api',
    headers?.get('x-tenant-id') ?? 'platform',
    headers?.get('x-workspace-id') ?? 'platform',
    path,
  ] as const;
}

function resourcePrefix(path: string) {
  const pathname = path.split('?')[0];
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] === 'admin' && segments[1]) return `/admin/${segments[1]}`;
  return segments[0] ? `/${segments[0]}` : '/';
}

export async function invalidateApiResource(path: string) {
  const prefix = resourcePrefix(path);
  const matchesResource = (query: { queryKey: readonly unknown[] }) => {
    const cachedPath = query.queryKey[3];
    return typeof cachedPath === 'string' && cachedPath.split('?')[0].startsWith(prefix);
  };
  await queryClient.cancelQueries({ predicate: matchesResource });
  queryClient.removeQueries({
    predicate: matchesResource,
  });
  // Most administrative writes can also change dashboard totals.
  queryClient.removeQueries({
    predicate: (query) => typeof query.queryKey[3] === 'string'
      && query.queryKey[3].split('?')[0] === '/admin/dashboard',
  });
}

export function clearApiCache() {
  queryClient.clear();
}
