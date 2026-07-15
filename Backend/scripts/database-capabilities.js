import 'dotenv/config';
import pg from 'pg';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  const result = await client.query(`
    SELECT
      current_setting('server_version') AS version,
      current_user AS username,
      rolsuper,
      rolcreaterole,
      rolcreatedb,
      rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
  `);

  console.log(JSON.stringify(result.rows[0], null, 2));
} finally {
  await client.end();
}
