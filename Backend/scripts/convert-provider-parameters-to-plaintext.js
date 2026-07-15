import 'dotenv/config';
import pg from 'pg';
import { decryptCredential } from '../src/security/credential-crypto.js';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query('BEGIN');
  const encrypted = await client.query(
    `SELECT id, encrypted_value FROM ai_provider_parameters
     WHERE is_secret = true AND encrypted_value IS NOT NULL
     FOR UPDATE`,
  );
  for (const parameter of encrypted.rows) {
    await client.query(
      `UPDATE ai_provider_parameters
       SET plain_value = $2, encrypted_value = NULL, is_secret = false
       WHERE id = $1`,
      [parameter.id, decryptCredential(parameter.encrypted_value)],
    );
  }
  await client.query('COMMIT');
  console.log(`Converted ${encrypted.rowCount} provider parameter(s) to plaintext.`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
