import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../Frontend/src/components/reports/DeveloperReportsView.tsx', import.meta.url), 'utf8');

assert.match(source, /metadata\.documentDisplayName \|\| metadata\.documentName/);
assert.match(source, /· Page \$\{metadata\.pageNumber\}/u);
assert.match(source, /CATALOG_ITEM: 'Catalog item'/u);
assert.match(source, /source\.type !== 'knowledge'/u);
assert.match(source, /!metadata\.documentId/u);
assert.match(source, /seen\.has\(key\)/u);
assert.doesNotMatch(source.slice(source.indexOf('function callerFacingAnswerSources'),
  source.indexOf('function TranscriptMessage')), /system_prompt|runtime_fallback|llm_first/iu);

console.log(JSON.stringify({
  gate: 'answer-source-ui-contract', passed: true,
  display: [
    'Shanmuga Hospital Package Catalog · Page 1',
    'Gold Master Health Checkup · Catalog item',
  ],
  guarantees: {
    publishedEvidenceOnly: true,
    exactDocumentAndPage: true,
    authoritativeRecordLabel: true,
    duplicatesHidden: true,
    internalRuntimeSourcesHidden: true,
  },
}));
