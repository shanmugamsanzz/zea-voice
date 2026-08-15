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
    'RULE: explain_available_options',
    'SITUATION: caller asks for available options | caller requests an overview',
    'RESPONSE_MODE: exact',
  ],
  [
    'RESPONSE: Approved overview response.',
    'RULE: submit_callback_request',
    'EXAMPLE: caller asks to be contacted later',
    'RESPONSE_MODE: instruction',
    'PRIORITY: 25',
    'TOOL: callback.schedule_v1',
    'RESPONSE: Ask only for fields required by the configured tool.',
  ],
));

assert.equal(structured.recordCount, 2);
assert.deepEqual(structured.records[0].conditions, {
  examples: ['caller asks for available options', 'caller requests an overview'],
});
assert.equal(structured.records[0].actionConfig.responseMode, 'exact');
assert.equal(structured.records[0].responseTemplate, 'Approved overview response.');
assert.equal(structured.records[0].sourcePageStart, 1);
assert.equal(structured.records[0].sourcePageEnd, 2);
assert.equal(structured.records[1].priority, 25);
assert.equal(structured.records[1].actionType, 'configured_tool');
assert.equal(structured.records[1].actionConfig.toolIdentifier, 'callback.schedule_v1');

const unsupportedShorthand = processExtractedCategory('workflow_rules', extractionFromPages([
  'customer asks for support -> Transfer to support',
  'IF customer says goodbye THEN hang up',
]));
assert.equal(unsupportedShorthand.recordCount, 0);
assert.equal(unsupportedShorthand.errors.length, 2);

const missingTool = processExtractedCategory('workflow_rules', extractionFromPages([
  'RULE: action_without_identifier',
  'SITUATION: caller requests an external action',
  'RESPONSE_MODE: instruction',
  'RESPONSE: Execute it.',
]));
assert.equal(missingTool.recordCount, 0);
assert.match(missingTool.errors[0], /explicit ACTION or TOOL identifier/u);

const malformed = processExtractedCategory('workflow_rules', extractionFromPages([
  'RULE: missing_response',
  'SITUATION: caller asks a question',
  'RESPONSE_MODE: exact',
]));
assert.equal(malformed.recordCount, 0);
assert.match(malformed.warnings[0], /no RESPONSE/u);

console.log('Structured Workflow Rules extraction verification passed.');
