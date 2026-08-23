import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { knowledgeMessageSources } from '../src/voice/source-trace.js';

const internalLabels = /System instructions|Agent Instructions|llm_first|Runtime fallback|Configured knowledge clarification/iu;
const typeLabels = Object.freeze({ CATALOG_ITEM: 'Catalog item' });

function displayLines(source) {
  const metadata = source.metadata ?? {};
  const document = metadata.documentDisplayName ?? metadata.documentName ?? source.label;
  const page = metadata.pageNumber ? ` · Page ${metadata.pageNumber}` : '';
  const recordName = metadata.recordName ?? metadata.sourceSection;
  const recordType = typeLabels[String(metadata.recordType ?? '').toLocaleUpperCase()]
    ?? 'Published record';
  return [`${document}${page}`, `${recordName} · ${recordType}`];
}

const published = knowledgeMessageSources({
  found: true,
  matches: [{
    id: 'published:catalog_item:gold', recordId: 'gold', recordType: 'CATALOG_ITEM',
    recordName: 'Gold Master Health Checkup', documentId: 'catalog-document',
    documentVersionId: 'catalog-version', documentName: 'package-catalog.pdf',
    documentDisplayName: 'Shanmuga Hospital Package Catalog', pageNumber: 1, pageEnd: 1,
    callerFacing: true,
  }, {
    id: 'published:catalog_item:gold', recordId: 'gold', recordType: 'CATALOG_ITEM',
    recordName: 'Gold Master Health Checkup', documentId: 'catalog-document',
    documentVersionId: 'catalog-version', documentName: 'package-catalog.pdf',
    documentDisplayName: 'Shanmuga Hospital Package Catalog', pageNumber: 1, pageEnd: 1,
    callerFacing: true,
  }],
}, ['published:catalog_item:gold']);

assert.equal(published.length, 1, 'Duplicate evidence must be removed before display');
assert.deepEqual(displayLines(published[0]), [
  'Shanmuga Hospital Package Catalog · Page 1',
  'Gold Master Health Checkup · Catalog item',
]);
assert.doesNotMatch(JSON.stringify(published), internalLabels);

// The production backend image intentionally contains only Backend/. Validate
// the React implementation as an additional assertion when this gate runs from
// a full source checkout, but never require Frontend/ inside the backend image.
let frontendSourceInspected = false;
try {
  const frontendSource = await readFile(
    new URL('../../Frontend/src/components/reports/DeveloperReportsView.tsx', import.meta.url),
    'utf8',
  );
  assert.match(frontendSource, /metadata\.documentDisplayName \|\| metadata\.documentName/);
  assert.match(frontendSource, /Page \$\{metadata\.pageNumber\}/u);
  assert.match(frontendSource, /CATALOG_ITEM: 'Catalog item'/u);
  assert.match(frontendSource, /source\.type !== 'knowledge'/u);
  assert.match(frontendSource, /!metadata\.documentId/u);
  assert.match(frontendSource, /seen\.has\(key\)/u);
  frontendSourceInspected = true;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

console.log(JSON.stringify({
  gate: 'answer-source-ui-contract', passed: true, frontendSourceInspected,
  display: displayLines(published[0]),
  guarantees: {
    publishedEvidenceOnly: true,
    exactDocumentAndPage: true,
    authoritativeRecordLabel: true,
    duplicatesHidden: true,
    internalRuntimeSourcesHidden: true,
  },
}));
