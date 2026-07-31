import assert from 'node:assert/strict';
import { TranscriptPersistenceQueue } from '../src/voice/transcript-persistence-queue.js';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.REDIS_HOST ??= '127.0.0.1';

const releases = [];
const persisted = [];
const queue = new TranscriptPersistenceQueue({
  persist: (entry) => new Promise((resolve) => {
    releases.push(() => { persisted.push(entry); resolve(); });
  }),
});

const combinedSources = [
  { type: 'system_prompt', id: 'agent-1', label: 'Instructions', metadata: {} },
  { type: 'knowledge', id: 'record-1', label: 'catalog', metadata: { documentName: 'packages.pdf' } },
  { type: 'tool', id: 'tool-1', label: 'appointment_slots', metadata: { success: true } },
  { type: 'llm', id: 'model-1', label: 'GPT', metadata: { finishReason: 'stop' } },
];

const first = queue.enqueue({ callId: 'call-1', sequenceNumber: 1, text: 'First', sources: combinedSources });
queue.enqueue({ callId: 'call-1', sequenceNumber: 2, text: 'Second', sources: [] });
assert.equal(first.queued, true);
assert.equal(persisted.length, 0, 'enqueue must not wait for database persistence');

await new Promise((resolve) => setImmediate(resolve));
assert.equal(releases.length, 1, 'entries must persist serially');
releases.shift()();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(releases.length, 1);
releases.shift()();
const metrics = await queue.flush();

assert.deepEqual(persisted.map((entry) => entry.sequenceNumber), [1, 2]);
assert.deepEqual(persisted[0].sources.map((source) => source.type), [
  'system_prompt', 'knowledge', 'tool', 'llm',
]);
assert.deepEqual(metrics, { pending: 0, saved: 2, failed: 0 });

const { appendTranscriptEntry } = await import('../src/calls/call.service.js');
let insertValues;
await appendTranscriptEntry({
  callId: '00000000-0000-4000-8000-000000000001',
  sequenceNumber: 3,
  speaker: 'agent',
  text: 'Combined answer',
  sources: [...combinedSources, combinedSources[1]],
}, {
  contextRunner: async (operation) => operation({
    async query(sql, values) {
      if (sql.startsWith('SELECT tenant_id')) {
        return { rowCount: 1, rows: [{ tenant_id: '00000000-0000-4000-8000-000000000002' }] };
      }
      assert.ok(sql.includes('sources'));
      insertValues = values;
      return { rowCount: 1, rows: [{ id: 'entry-1' }] };
    },
  }),
});
const storedSources = JSON.parse(insertValues[7]);
assert.deepEqual(storedSources.map((source) => source.type), [
  'system_prompt', 'knowledge', 'tool', 'llm',
]);
assert.equal(storedSources.length, 4, 'duplicate combined sources must not be persisted');

console.log(JSON.stringify({ success: true, task: 'Asynchronous combined transcript source persistence' }));
