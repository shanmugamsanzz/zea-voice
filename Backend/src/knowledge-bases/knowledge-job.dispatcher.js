import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { AppError } from '../middleware/errors.js';
import { processKnowledgeJob } from './knowledge-processing.service.js';
import { processSemanticIndexJob } from './semantic-index.service.js';
import { processKnowledgeDeletionJob } from './knowledge-deletion.service.js';

export async function executeKnowledgeJob(jobId) {
  const job = await withPlatformAdminContext(null, async (client) => {
    const result = await client.query(
      'SELECT job_type FROM knowledge_processing_jobs WHERE id = $1',
      [jobId],
    );
    return result.rows[0] ?? null;
  });
  if (!job) throw new AppError(404, 'Knowledge processing job was not found', 'KNOWLEDGE_JOB_NOT_FOUND');
  if (job.job_type === 'extract') return processKnowledgeJob(jobId);
  if (job.job_type === 'index') return processSemanticIndexJob(jobId);
  if (job.job_type === 'delete_document' || job.job_type === 'delete_knowledge_base') {
    return processKnowledgeDeletionJob(jobId);
  }
  throw new AppError(409, `Unsupported knowledge job type: ${job.job_type}`, 'KNOWLEDGE_JOB_TYPE_UNSUPPORTED');
}
