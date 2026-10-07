import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { withPlatformAdminContext } from '../infrastructure/database-context.js';
import { processQueuedPhoneTest } from './agent-phone-test-queue.service.js';
import { enqueueDueFollowUps, recoverCampaignFollowUps } from '../calls/follow-up-dispatch.service.js';

let timer, running;
let afterTenantId = null;
export function startPhoneTestQueueWorker() {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = (async () => {
      await enqueueDueFollowUps();
      await recoverCampaignFollowUps().catch(error=>logger.warn({err:error},'Campaign follow-up delivery recovery deferred'));
      const requests = await withPlatformAdminContext(null, async client => {
        // Dispatch outcome after a crash is ambiguous. Never redial it.
        await client.query(`UPDATE agent_phone_test_requests SET status='failed',last_error='PHONE_TEST_DISPATCH_UNCONFIRMED',updated_at=now()
          WHERE status='dispatching' AND updated_at < now()-interval '5 minutes'`);
        return (await client.query(`SELECT DISTINCT ON (tenant_id) id,tenant_id FROM agent_phone_test_requests
          WHERE status='queued' AND ($1::uuid IS NULL OR tenant_id>$1)
          ORDER BY tenant_id,created_at,id LIMIT 100`, [afterTenantId])).rows;
      });
      afterTenantId = requests.length === 100 ? requests.at(-1).tenant_id : null;
      for (let index = 0; index < requests.length; index += env.CAMPAIGN_WORKER_CONCURRENCY) {
        await Promise.all(requests.slice(index, index + env.CAMPAIGN_WORKER_CONCURRENCY).map(request =>
          processQueuedPhoneTest(request.id).catch(error => logger.warn({ err: error, requestId: request.id }, 'Phone-test queue dispatch deferred'))));
      }
    })().catch(error => logger.error({ err: error }, 'Phone-test queue worker failed'));
    try { await running; } finally { running = undefined; }
  };
  timer = setInterval(() => void tick(), env.CONCURRENCY_RETRY_DELAY_MS);
  timer.unref();
  void tick();
}
export async function closePhoneTestQueueWorker() {
  clearInterval(timer); timer = undefined;
  await running;
  afterTenantId = null;
}
