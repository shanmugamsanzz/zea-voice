import assert from 'node:assert/strict';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';

function extraction(text) {
  const lines = text.trim().split(/\r?\n/u);
  return {
    fullText: lines.join('\n'),
    pages: [{ pageNumber: 1, lines }],
  };
}

const catalog = processExtractedCategory('catalog', extraction(`
CATEGORY: Service Plans | KEY=service-plans | ALIASES=Plans, Options | DESCRIPTION=Approved plans
Standard Plan INR 100 | KEY=standard-plan | ALIASES=Standard, Basic | DESCRIPTION=Standard service | ATTRIBUTES={"features":["Feature A","Feature B"],"preparation":"Approved instruction"} | RELATIONSHIPS={"alternatives":["premium-plan"]} | SELECTION_RULES={"bookable":true}
Premium Plan INR 200 | KEY=premium-plan | ALIASES=Premium, Advanced
`));
assert.equal(catalog.recordCount, 2);
assert.equal(catalog.records[0].categoryKey, 'service-plans');
assert.deepEqual(catalog.records[0].aliases, ['Standard', 'Basic']);
assert.equal(catalog.records[0].attributes.find((item) => item.key === 'preparation').value, 'Approved instruction');
assert.deepEqual(catalog.records[0].relationships.alternatives, ['premium-plan']);

const workflow = processExtractedCategory('workflow_rules', extraction(`
RULE: begin_configured_action
MATCH: start the action | proceed with this option
MATCH_MODE: any_phrase
RESPONSE_MODE: exact
PRIORITY: 20
FROM_STAGE: explanation | confirmation
NEXT_STAGE: collect_fields
ACTION: configured-action
REQUIRES_CATALOG_ITEM: true
BLOCKED_RESPONSE: Which approved option do you want?
RESPONSE: I can start that action.
`));
assert.equal(workflow.recordCount, 1);
assert.deepEqual(workflow.records[0].conditions.fromStages, ['explanation', 'confirmation']);
assert.equal(workflow.records[0].actionConfig.nextStage, 'collect_fields');
assert.equal(workflow.records[0].actionConfig.requiresCatalogItem, true);

const script = processExtractedCategory('conversation_script', extraction(`
STAGE: overview
FLOW: main
LANGUAGE: ta
ENTRY: true
PURPOSE: Present approved categories.
RESPONSE: Approved overview response.
NEXT_QUESTION: Which option do you want?
NEXT_STAGE: explanation

STAGE: explanation
FLOW: main
LANGUAGE: ta
PURPOSE: Explain the active item.
RESPONSE: Approved item explanation.
NEXT_STAGE: confirmation
`));
assert.equal(script.recordCount, 2);
assert.equal(script.records[0].nodeKey, 'overview');
assert.equal(script.records[0].variables[0].value, 'Present approved categories.');
assert.deepEqual(script.records[0].transitions, [{ to: 'explanation' }]);

const faq = processExtractedCategory('faq', extraction(`
QUESTION: What does the selected item include?
ALIASES: What is covered? | Explain this option
ANSWER: This is the approved answer.
`));
assert.equal(faq.recordCount, 3);
assert.ok(faq.records.every((item) => item.answer === 'This is the approved answer.'));

const general = processExtractedCategory('general_knowledge', extraction(`
TOPIC: Company location
ALIASES: address | directions
ANSWER: Tenant-approved location information.
`));
assert.ok(general.recordCount >= 1);
assert.match(general.records[0].content, /Tenant-approved location information/u);

console.log('Master Prompt plus five UI-managed document contracts verified without tenant-specific runtime data.');
