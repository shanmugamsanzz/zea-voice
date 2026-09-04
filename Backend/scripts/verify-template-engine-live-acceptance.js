import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateTemplateEngineActivationEvidence } from
  '../src/voice/interaction/template-engine-shadow-cutover.js';

const argument = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))
  ?.slice(name.length + 3) ?? null;
const reportFile = argument('report-file') ?? process.env.TEMPLATE_ENGINE_LIVE_ACCEPTANCE_REPORT;
const expectedGitSha = argument('git-sha') ?? process.env.DEPLOY_GIT_SHA;
assert.ok(reportFile, 'A real live shadow acceptance report is required');
assert.ok(expectedGitSha, 'The deployed Git SHA is required');
const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const validation = validateTemplateEngineActivationEvidence(report, expectedGitSha);
assert.equal(validation.valid, true,
  `Template-engine live acceptance failed: ${validation.reasons.join(', ')}`);
console.log(JSON.stringify({
  gate: 'template-engine-live-acceptance', passed: true,
  gitSha: expectedGitSha, repeats: report.repeats,
  tenants: report.tenants, languages: report.languages,
  scenarios: report.scenarios,
  scenarioRuns: report.scenarioRuns?.length ?? 0,
  legacyDeletionAuthorized: true,
}, null, 2));
