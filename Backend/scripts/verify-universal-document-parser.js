import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import {
  assertKnowledgeRecordReviewable,
  assertStructuredDocumentReviewable,
} from '../src/knowledge-bases/knowledge-review.service.js';
import { validateKnowledgeRecord } from '../src/knowledge-bases/knowledge-record-validation.js';
import { parseKnowledgeReviewInput, updateReviewRecordSchema } from '../src/knowledge-bases/knowledge-review.schemas.js';

function extraction(text) {
  const lines = text.trim().split(/\r?\n/u);
  return { fullText: lines.join('\n'), pages: [{ pageNumber: 1, lines }] };
}

const industries = [
  ['healthcare', 'Consultation', null, null],
  ['property', 'Site Visit', 25, 'USD'],
  ['education', 'Career Guidance', null, null],
  ['insurance', 'Policy Review', 40, 'USD'],
  ['retail', 'Gift Wrap', 5, 'USD'],
];

for (const [industry, name, price, currency] of industries) {
  const priceFields = price === null ? '' : ` | PRICE=${price} | CURRENCY=${currency}`;
  const parsed = processExtractedCategory('catalog', extraction(`
CATEGORY: ${industry} services | KEY=${industry}-services
ITEM: ${name} | KEY=${industry}-item | DESCRIPTION=Approved tenant description${priceFields}
`));
  assert.equal(parsed.errors.length, 0, `${industry} catalog must parse without a special branch`);
  assert.equal(parsed.recordCount, 1);
  assert.equal(parsed.records[0].name, name);
  assert.equal(parsed.records[0].price, price);
  assert.equal(parsed.records[0].currency, currency);
}

const legacyPriced = processExtractedCategory('catalog', extraction('Standard Service USD 99'));
assert.equal(legacyPriced.records[0].price, 99);
assert.equal(legacyPriced.records[0].currency, 'USD');

const invalidCatalog = processExtractedCategory('catalog', extraction(`
ITEM: Broken Price | KEY=broken-price | PRICE=unknown | CURRENCY=USD
ITEM: Broken Metadata | KEY=broken-metadata | RELATIONSHIPS={not-json}
`));
assert.ok(invalidCatalog.errors.length >= 2);

const informationalRule = processExtractedCategory('workflow_rules', extraction(`
RULE: explain_current_information
SITUATION: The caller asks about the current information
RESPONSE_MODE: exact
RESPONSE: Give the approved caller-facing answer.
`));
assert.equal(informationalRule.errors.length, 0);
assert.equal(informationalRule.records[0].actionType, 'respond');

const toolRule = processExtractedCategory('workflow_rules', extraction(`
RULE: submit_configured_request
EXAMPLE: The caller explicitly asks the configured request to be submitted
RESPONSE_MODE: instruction
TOOL: tenant.request.submit_v1
RESPONSE: Collect only fields required by the configured tool schema, then request execution.
`));
assert.equal(toolRule.errors.length, 0);
assert.equal(toolRule.records[0].actionType, 'configured_tool');
assert.equal(toolRule.records[0].actionConfig.toolIdentifier, 'tenant.request.submit_v1');

const missingTool = processExtractedCategory('workflow_rules', extraction(`
RULE: inferred_action_is_forbidden
SITUATION: Please transfer or schedule this request
RESPONSE_MODE: instruction
RESPONSE: Perform an action.
`));
assert.equal(missingTool.recordCount, 0);
assert.match(missingTool.errors.join(' '), /explicit ACTION or TOOL identifier/u);

const invalidToolIdentifier = processExtractedCategory('workflow_rules', extraction(`
RULE: invalid_tool_identifier
SITUATION: The caller asks for an external action
RESPONSE_MODE: instruction
ACTION: transfer customer now
RESPONSE: Request execution.
`));
assert.equal(invalidToolIdentifier.recordCount, 0);
assert.match(invalidToolIdentifier.errors.join(' '), /invalid configured tool identifier/u);

const shorthand = processExtractedCategory('workflow_rules', extraction('if caller asks to transfer then transfer them'));
assert.equal(shorthand.recordCount, 0);
assert.ok(shorthand.errors.length > 0);

assert.deepEqual(validateKnowledgeRecord('catalog_item', {
  name: 'Unpriced Service', itemKey: 'unpriced-service', price: null, currency: null,
}), []);
assert.throws(
  () => assertKnowledgeRecordReviewable({
    id: 'invalid-record', record_kind: 'workflow_rule', response_template: 'Run it',
    action_config: { responseMode: 'instruction' },
  }),
  (error) => error?.code === 'REVIEW_RECORD_INVALID',
);
assert.throws(
  () => assertKnowledgeRecordReviewable({
    id: 'invalid-price', record_kind: 'catalog_item', name: 'Priced Item', item_key: 'priced-item',
    price: 10, currency: null,
  }),
  (error) => error?.code === 'REVIEW_RECORD_INVALID',
);
assert.equal(parseKnowledgeReviewInput(updateReviewRecordSchema, { actionType: 'transfer_call' }).success, false);
assert.throws(
  () => assertStructuredDocumentReviewable({ id: 'invalid-document', validation_errors: ['Invalid record'] }),
  (error) => error?.code === 'STRUCTURED_VALIDATION_ERRORS',
);

const parserSource = await readFile(new URL('../src/knowledge-bases/category-processors.js', import.meta.url), 'utf8');
for (const businessTerm of ['hospital', 'real estate', 'school', 'insurance policy', 'retail store']) {
  assert.equal(parserSource.toLocaleLowerCase().includes(businessTerm), false,
    `Parser must not contain an industry branch for ${businessTerm}`);
}
assert.equal(parserSource.includes('inferActionType'), false);
assert.equal(parserSource.includes("includes('transfer')"), false);
assert.equal(parserSource.includes("includes('schedule')"), false);

const processingSource = await readFile(new URL('../src/knowledge-bases/knowledge-processing.service.js', import.meta.url), 'utf8');
const reviewSource = await readFile(new URL('../src/knowledge-bases/knowledge-review.service.js', import.meta.url), 'utf8');
assert.match(processingSource, /validationErrors/u);
assert.match(reviewSource, /STRUCTURED_VALIDATION_ERRORS/u);
assert.match(reviewSource, /REVIEW_RECORD_INVALID/u);

console.log('Universal five-document parser verified across healthcare, property, education, insurance and retail.');
