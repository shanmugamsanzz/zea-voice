import { closeDatabase } from '../src/infrastructure/database.js';
import { closeRedis, connectRedis } from '../src/infrastructure/redis.js';
import { purgePreviouslySoftDeletedKnowledgeBases } from '../src/knowledge-bases/knowledge-deletion.service.js';

const execute = process.argv.includes('--execute');
const confirmationArgument = process.argv.find((argument) => argument.startsWith('--confirm='));
const confirmationIndex = process.argv.indexOf('--confirm');
const confirmationToken = confirmationArgument?.slice('--confirm='.length)
  || (confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] : null);

try {
  if (execute) await connectRedis();
  const result = await purgePreviouslySoftDeletedKnowledgeBases({ execute, confirmationToken });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!execute && result.count > 0) {
    process.stdout.write('\nDRY RUN ONLY — no data was deleted. Review every item above.\n');
    process.stdout.write(`To execute this exact reviewed list:\n  npm run knowledge:purge-deleted -- --confirm=${result.confirmationToken}\n`);
  }
  if (execute && result.failedCount > 0) process.exitCode = 1;
} finally {
  await Promise.allSettled([closeRedis(), closeDatabase()]);
}
