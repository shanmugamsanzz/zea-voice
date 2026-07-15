import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { flushQueue, listQueueMetrics, listWorkerHeartbeats, pauseQueue, resumeQueue } from './queue.registry.js';

async function audit(actorUserId, action, queueName, data) {
  await withPlatformAdminContext(actorUserId, (client) => client.query(`INSERT INTO audit_logs
    (actor_user_id, actor_type, action, entity_type, entity_id, after_data)
    VALUES ($1, 'user', $2, 'bullmq_queue', $3, $4::jsonb)`,
  [actorUserId, action, queueName, JSON.stringify(data)]));
}

export function getQueueMonitor() {
  return listQueueMetrics();
}

export function getWorkerMonitor() {
  return listWorkerHeartbeats();
}

export async function setQueuePaused(actorUserId, queueName, paused) {
  if (paused) await pauseQueue(queueName); else await resumeQueue(queueName);
  await audit(actorUserId, paused ? 'QUEUE_PAUSED' : 'QUEUE_RESUMED', queueName, { paused });
  return { queueName, paused };
}

export async function emergencyFlush(actorUserId, queueName, reason) {
  const removedJobs = await flushQueue(queueName);
  await audit(actorUserId, 'QUEUE_EMERGENCY_FLUSHED', queueName, { removedJobs, reason });
  return { queueName, removedJobs, activeJobsAffected: 0, reason };
}
