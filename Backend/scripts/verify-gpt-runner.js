import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveConfiguration, validateScenario, dryRunSummary, loadConfiguration, readJson } from './gpt-runner/config.js';
import { main, parseArguments } from './gpt-runner/run.js';

const token = 'A'.repeat(43);
const raw = {
  agentTestLink: 'https://example.invalid/test/' + token,
  apiBaseUrl: 'https://example.invalid/api',
  language: 'ta-IN', scenario: './scenarios/tamil-smoke.json',
  maxTurns: 5, maxDurationSeconds: 120, outputDirectory: './outputs',
};
const baseDirectory = fileURLToPath(new URL('./gpt-runner/', import.meta.url));
const scenarioRaw = { id: 'tamil-smoke', language: 'ta-IN', openingQuestion: 'வணக்கம்', goals: ['Ask an information question.'] };
function capture() {
  let output = ''; let error = '';
  return { stdout: { write(value) { output += value; } }, stderr: { write(value) { error += value; } },
    output: () => output, error: () => error };
}
test('configuration resolves relative paths, bounds and API prefix', () => {
  const config = resolveConfiguration(raw, { baseDirectory });
  assert.equal(config.apiBaseUrl, 'https://example.invalid/api');
  assert.equal(config.shareToken, token);
  assert.equal(config.scenarioPath, path.join(baseDirectory, 'scenarios', 'tamil-smoke.json'));
  assert.equal(config.outputDirectory, path.join(baseDirectory, 'outputs'));
  assert.equal(config.language, 'ta-IN');
  assert.ok(Object.isFrozen(config));
});
test('agent link may come from environment without including a key in JSON', () => {
  const { agentTestLink, ...rest } = raw;
  const config = resolveConfiguration({ ...rest, agentTestLinkEnv: 'GPT_RUNNER_TEST_LINK' },
    { baseDirectory, environment: { GPT_RUNNER_TEST_LINK: agentTestLink } });
  assert.equal(config.shareToken, token);
  assert.throws(() => resolveConfiguration({ ...rest, agentTestLinkEnv: 'GPT_RUNNER_TEST_LINK' },
    { environment: {} }), /environment variable is missing/u);
  assert.throws(() => resolveConfiguration({ ...raw, agentTestLinkEnv: 'GPT_RUNNER_TEST_LINK' }), /not both/u);
});
test('unsafe routing, controls, invalid limits and unsupported fields are rejected', () => {
  for (const override of [
    { agentTestLink: 'http://remote.example/test/' + token },
    { agentTestLink: 'https://user:password@example.invalid/test/' + token },
    { agentTestLink: raw.agentTestLink + '?token=secret' },
    { agentTestLink: raw.agentTestLink + '#secret' },
    { agentTestLink: 'https://example.invalid/test/short' },
    { apiBaseUrl: 'https://other.invalid/api' },
    { maxTurns: 0 }, { maxTurns: 1.5 }, { maxTurns: 21 },
    { maxDurationSeconds: 9 }, { maxDurationSeconds: 601 },
    { language: 'invalid_language' }, { outputDirectory: '\u0000bad' },
    { scenario: 'https://example.invalid/scenario.json' },
    { apiKey: 'synthetic-secret' },
  ]) assert.throws(() => resolveConfiguration({ ...raw, ...override }), { name: 'ConfigurationError' });
  assert.equal(resolveConfiguration({ ...raw, agentTestLink: 'http://127.0.0.1:5020/test/' + token,
    apiBaseUrl: 'http://127.0.0.1:5020/api' }).apiBaseUrl, 'http://127.0.0.1:5020/api');
});
test('scenario requires matching language and bounded questions/goals', () => {
  assert.equal(validateScenario(scenarioRaw, 'ta-IN').id, 'tamil-smoke');
  for (const override of [
    { language: 'en-IN' }, { goals: [] }, { openingQuestion: '' },
    { openingQuestion: 'x'.repeat(2001) }, { id: '../secret' }, { tools: ['execute'] },
  ]) assert.throws(() => validateScenario({ ...scenarioRaw, ...override }, 'ta-IN'), { name: 'ConfigurationError' });
});
test('dry-run summary never contains raw link, token, question or output path', () => {
  const config = resolveConfiguration(raw, { baseDirectory });
  const scenario = validateScenario(scenarioRaw, config.language);
  const output = JSON.stringify(dryRunSummary({ config, scenario }));
  for (const secret of [raw.agentTestLink, token, scenario.openingQuestion, config.outputDirectory]) assert.ok(!output.includes(secret));
  const result = JSON.parse(output);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.filesWritten, 0);
  assert.equal(result.liveAudioImplemented, false);
});
test('CLI dry-run uses no network; live mode is refused before configuration loading', async () => {
  const savedFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests += 1; throw new Error('No network allowed in Task 2.'); };
  try {
    const io = capture();
    const example = fileURLToPath(new URL('./gpt-runner/config.example.json', import.meta.url));
    assert.equal(await main(['--config', example, '--dry-run'], io), 0);
    assert.equal(JSON.parse(io.output()).mode, 'dry-run');
    assert.equal(io.error(), '');
    assert.equal(requests, 0);
    let loaded = false;
    const live = capture();
    assert.equal(await main(['--config', 'synthetic-private-path.json'], { ...live,
      load: async () => { loaded = true; throw new Error('must not load'); } }), 2);
    assert.equal(loaded, false);
    assert.match(live.error(), /Live execution requires/u);
    assert.ok(!live.error().includes('synthetic-private-path'));
  } finally { globalThis.fetch = savedFetch; }
});
test('CLI rejects malformed arguments and suppresses native private errors', async () => {
  assert.throws(() => parseArguments(['--config']), /requires/u);
  assert.throws(() => parseArguments(['--dry-run', '--dry-run']), /duplicate/u);
  assert.throws(() => parseArguments(['--secret=sensitive']), /Unknown/u);
  const io = capture();
  assert.equal(await main(['--config', 'unused.json', '--dry-run'], { ...io,
    load: async () => { throw new Error('synthetic-private-token'); } }), 2);
  assert.ok(!io.error().includes('synthetic-private-token'));
});
test('JSON reader handles BOM and hides malformed, oversized and missing-file details', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'zea-runner-task2-'));
  try {
    const file = path.join(directory, 'input.json');
    await writeFile(file, '\uFEFF{"ok":true}');
    assert.deepEqual(await readJson(file, 'Fixture'), { ok: true });
    await writeFile(file, '{"private":"synthetic-secret",');
    await assert.rejects(readJson(file, 'Fixture'), (error) => error.name === 'ConfigurationError'
      && !error.message.includes('synthetic-secret'));
    await writeFile(file, 'x'.repeat(65537));
    await assert.rejects(readJson(file, 'Fixture'), /64 KiB/u);
    await assert.rejects(readJson(path.join(directory, 'private-filename.json'), 'Fixture'),
      (error) => error.name === 'ConfigurationError' && !error.message.includes('private-filename'));
  } finally {
    const relative = path.relative(tmpdir(), directory);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      && path.basename(directory).startsWith('zea-runner-task2-'), 'Cleanup must stay in its test temp directory.');
    await rm(directory, { recursive: true, force: true });
  }
});
test('direct CLI entry point runs from an unrelated working directory', () => {
  const entry = fileURLToPath(new URL('./gpt-runner/run.js', import.meta.url));
  const example = fileURLToPath(new URL('./gpt-runner/config.example.json', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--config', example, '--dry-run'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).sessionsCreated, 0);
});

