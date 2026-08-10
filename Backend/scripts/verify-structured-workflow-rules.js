import assert from 'node:assert/strict';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';

function extractionFromPages(...pages) {
  return {
    pages: pages.map((lines, index) => ({ pageNumber: index + 1, lines })),
    fullText: pages.flat().join('\n'),
  };
}

const structured = processExtractedCategory('workflow_rules', extractionFromPages(
  [
    'RULE: package_overview',
    'MATCH: package explain பண்ணுங்க | என்னென்ன packages இருக்கு | package explain பண்ணுங்க',
    'MATCH_MODE: any_phrase',
    'RESPONSE_MODE: exact',
  ],
  [
    'RESPONSE: எங்ககிட்ட பல packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?',
    'RULE: callback_request',
    'MATCH: call me later | அப்புறம் call பண்ணுங்க',
    'MATCH_MODE: contains',
    'RESPONSE_MODE: instruction',
    'PRIORITY: 25',
    'RESPONSE: Ask for a suitable callback time.',
  ],
));

assert.equal(structured.recordCount, 2);
assert.deepEqual(structured.records[0].conditions, {
  triggerPhrases: ['package explain பண்ணுங்க', 'என்னென்ன packages இருக்கு'],
  matchMode: 'any_phrase',
});
assert.equal(structured.records[0].actionConfig.responseMode, 'exact');
assert.equal(structured.records[0].responseTemplate, 'எங்ககிட்ட பல packages இருக்குங்க. எது பத்தி தெரிஞ்சிக்கணும்?');
assert.equal(structured.records[0].sourcePageStart, 1);
assert.equal(structured.records[0].sourcePageEnd, 2);
assert.equal(structured.records[1].priority, 25);
assert.equal(structured.records[1].conditions.matchMode, 'contains');

const legacy = processExtractedCategory('workflow_rules', extractionFromPages([
  'customer asks for support -> Transfer to support',
  'IF customer says goodbye THEN hang up',
]));
assert.equal(legacy.recordCount, 2);
assert.deepEqual(legacy.records[0].conditions, {});
assert.equal(legacy.records[0].actionType, 'transfer_call');
assert.equal(legacy.records[1].actionType, 'hangup_call');

const malformed = processExtractedCategory('workflow_rules', extractionFromPages([
  'RULE: missing_response',
  'MATCH: hello',
  'RESPONSE_MODE: exact',
]));
assert.equal(malformed.recordCount, 0);
assert.match(malformed.warnings[0], /no RESPONSE/u);

console.log('Structured Workflow Rules extraction verification passed.');
