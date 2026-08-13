import assert from 'node:assert/strict';
import { processExtractedCategory } from '../src/knowledge-bases/category-processors.js';
import { rankHybridEvidence, resolveEvidenceConfidence } from '../src/knowledge-bases/hybrid-evidence-ranker.js';

const extraction = (text) => ({
  fullText: text,
  pages: [{ pageNumber: 1, lines: text.trim().split(/\r?\n/u) }],
});
const rules = processExtractedCategory('workflow_rules', extraction(`
RULE: ambiguous_evidence_response
CONFIDENCE_OUTCOME: ambiguous
RESPONSE_MODE: exact
PRIORITY: 900
RESPONSE: Approved targeted clarification.

RULE: no_evidence_response
CONFIDENCE_OUTCOME: none
RESPONSE_MODE: exact
PRIORITY: 910
RESPONSE: Approved safe fallback.
`));
assert.equal(rules.recordCount, 2);
assert.equal(rules.records[0].conditions.confidenceOutcome, 'ambiguous');
assert.equal(rules.records[1].conditions.confidenceOutcome, 'none');

const highRanked = rankHybridEvidence([{
  route: 'catalog', found: true, content: 'Approved facts',
  source: { recordId: 'record-a' },
  item: { id: 'item-a', key: 'item-a', categoryKey: 'category-a' },
  entityResolution: { method: 'normalized', confidence: 1 },
}], { selectedItemId: 'item-a', activeCategoryKey: 'category-a' });
assert.equal(resolveEvidenceConfidence(highRanked).outcome, 'high');

const ambiguousRanked = rankHybridEvidence([{
  route: 'semantic', found: true, content: 'Possible approved fact A',
  source: { recordId: 'record-b' }, matches: [{ recordType: 'KNOWLEDGE_CHUNK', score: 0.71 }],
}, {
  route: 'semantic', found: true, content: 'Possible approved fact B',
  source: { recordId: 'record-c' }, matches: [{ recordType: 'KNOWLEDGE_CHUNK', score: 0.69 }],
}]);
assert.equal(resolveEvidenceConfidence(ambiguousRanked).outcome, 'ambiguous');
assert.equal(resolveEvidenceConfidence([]).outcome, 'none');

console.log(JSON.stringify({
  highConfidenceBundle: true,
  ambiguousUsesDocumentRule: true,
  noResultUsesDocumentRule: true,
}, null, 2));
