import net from 'node:net';
import { z } from 'zod';

function isCidr(value) {
  const [address, prefix, extra] = value.split('/');
  const version = net.isIP(address);
  if (!version || extra !== undefined) return false;
  if (prefix === undefined || !/^\d+$/.test(prefix)) return false;
  const number = Number(prefix);
  return version === 4 ? number <= 32 : number <= 128;
}

const cidr = z.string().trim().refine(isCidr, 'A valid IPv4 or IPv6 CIDR is required');
export const updatePlatformSettingsSchema = z.object({
  adminIpAllowlist: z.array(cidr).min(1).max(100).optional(),
  maxSessionTimeoutSeconds: z.number().int().min(300).max(86400).optional(),
  compliancePolicy: z.enum(['standard_hipaa_pci', 'strict_gdpr', 'relaxed_developer']).optional(),
  sipRelayRegion: z.enum(['us_east', 'eu_central', 'apac_south']).optional(),
  confirmAccessLoss: z.boolean().default(false),
}).refine((value) => Object.keys(value).some((key) => key !== 'confirmAccessLoss'), {
  message: 'At least one setting is required',
});

export function parsePlatformSettingInput(schema, value) {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  return { success: false, issues: result.error.issues.map((issue) => ({
    field: issue.path.join('.'), message: issue.message,
  })) };
}
