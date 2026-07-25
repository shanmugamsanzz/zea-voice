import assert from 'node:assert/strict';
import {
  createPronunciationGroupSchema,
  createPronunciationRuleSchema,
  listPronunciationGroupsSchema,
  parsePronunciationInput,
  PRONUNCIATION_MATCH_TYPES,
  PRONUNCIATION_RULE_DEFAULTS,
  replaceAgentPronunciationGroupsSchema,
  updatePronunciationGroupSchema,
  updatePronunciationRuleSchema,
} from '../src/pronunciations/pronunciation.schemas.js';

assert.deepEqual(PRONUNCIATION_MATCH_TYPES, ['exact', 'whole_word']);
assert.deepEqual(PRONUNCIATION_RULE_DEFAULTS, {
  matchType: 'whole_word', caseSensitive: false, priority: 100, enabled: true,
});

const tamilRule = parsePronunciationInput(createPronunciationRuleSchema, {
  sourceText: '  Shanmuga  ',
  spokenText: '  சண்முகா  ',
});
assert.equal(tamilRule.success, true);
assert.deepEqual(tamilRule.data, {
  sourceText: 'Shanmuga',
  spokenText: 'சண்முகா',
  matchType: 'whole_word',
  caseSensitive: false,
  priority: 100,
  enabled: true,
});

const punctuationRule = createPronunciationRuleSchema.parse({
  sourceText: '/',
  spokenText: 'or',
  matchType: 'exact',
  caseSensitive: true,
  priority: 10,
  enabled: false,
});
assert.equal(punctuationRule.matchType, 'exact');
assert.equal(punctuationRule.priority, 10);
assert.equal(punctuationRule.enabled, false);

assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: '', spokenText: 'test' }).success, false);
assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: 'ECG', spokenText: '' }).success, false);
assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: 'ECG', spokenText: 'E C G', priority: -1 }).success, false);
assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: 'ECG', spokenText: 'E C G', matchType: 'regex' }).success, false);
assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: 'ECG\n', spokenText: 'E C G' }).success, true);
assert.equal(createPronunciationRuleSchema.safeParse({ sourceText: 'ECG\u0000', spokenText: 'E C G' }).success, false);
assert.equal(updatePronunciationRuleSchema.safeParse({}).success, false);
assert.equal(updatePronunciationRuleSchema.safeParse({ enabled: false }).success, true);

assert.deepEqual(createPronunciationGroupSchema.parse({ name: 'Medical Terms' }), {
  name: 'Medical Terms', language: 'und', status: 'active', description: null,
});
assert.equal(createPronunciationGroupSchema.safeParse({ name: 'Medical', language: 'ta-IN' }).success, true);
assert.equal(createPronunciationGroupSchema.safeParse({ name: 'Medical', language: 'Tamil India' }).success, false);
assert.equal(updatePronunciationGroupSchema.safeParse({}).success, false);
assert.equal(listPronunciationGroupsSchema.parse({ page: '2' }).page, 2);
assert.deepEqual(replaceAgentPronunciationGroupsSchema.parse({
  groupIds: [
    '11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ],
}).groupIds, [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]);

console.log(JSON.stringify({ success: true, task: 'Pronunciation rule contracts' }));
