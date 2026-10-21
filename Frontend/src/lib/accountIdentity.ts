export interface AccountUser {
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  tenantName?: string | null;
}

export function accountIdentity(user: AccountUser | null) {
  const parts = [user?.firstName, user?.lastName]
    .map(value => value?.trim() ?? '').filter(value => value && value !== '-');
  const name = parts.join(' ') || user?.email?.trim() || 'Account';
  const initials = parts.length
    ? [parts[0], ...(parts.length > 1 ? [parts[parts.length - 1]] : [])].map(part => Array.from(part)[0]).join('').toLocaleUpperCase()
    : Array.from(name)[0].toLocaleUpperCase();
  return { name, company: user?.tenantName?.trim() || '', initials };
}
