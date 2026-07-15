import 'dotenv/config';
import { z } from 'zod';
import { closeDatabase } from '../src/infrastructure/database.js';
import { withPlatformAdminContext } from '../src/infrastructure/database-context.js';
import { hashPassword } from '../src/auth/password.js';

const inputSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(12).max(200),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
});

const parsed = inputSchema.safeParse({
  email: process.env.SUPER_ADMIN_EMAIL,
  password: process.env.SUPER_ADMIN_PASSWORD,
  firstName: process.env.SUPER_ADMIN_FIRST_NAME,
  lastName: process.env.SUPER_ADMIN_LAST_NAME,
});

if (!parsed.success) {
  console.error('Set valid SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_FIRST_NAME and SUPER_ADMIN_LAST_NAME values.');
  process.exitCode = 1;
} else {
  try {
    const passwordHash = await hashPassword(parsed.data.password);
    const user = await withPlatformAdminContext(null, async (client) => {
      const result = await client.query(
        `INSERT INTO users
          (email, password_hash, first_name, last_name, status, platform_role, email_verified_at)
         VALUES ($1, $2, $3, $4, 'active', 'super_admin', now())
         ON CONFLICT (email) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             status = 'active',
             platform_role = 'super_admin',
             password_changed_at = now(),
             deleted_at = NULL
         RETURNING id, email::text`,
        [parsed.data.email, passwordHash, parsed.data.firstName, parsed.data.lastName],
      );
      return result.rows[0];
    });
    console.log(`Super Admin is ready: ${user.email} (${user.id})`);
  } finally {
    await closeDatabase();
  }
}
