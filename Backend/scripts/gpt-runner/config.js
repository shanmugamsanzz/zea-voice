import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_JSON_BYTES = 64 * 1024;
const CONFIG_KEYS = new Set([
  'agentTestLink', 'agentTestLinkEnv', 'apiBaseUrl', 'language', 'scenario',
  'maxTurns', 'maxDurationSeconds', 'outputDirectory', 'callerConfig', 'recordAudio',
]);
const SCENARIO_KEYS = new Set(['id', 'language', 'openingQuestion', 'goals', 'expectedFacts']);
export class ConfigurationError extends Error {
  constructor(message) { super(message); this.name = 'ConfigurationError'; }
}
function fail(message) { throw new ConfigurationError(message); }
function object(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + ' must be a JSON object.');
  if (Object.keys(value).some((key) => !keys.has(key))) fail(label + ' contains unsupported fields.');
}
function text(value, label, maximum = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) fail(label + ' must be bounded non-empty text without control characters.');
  return value.trim();
}
function integer(value, fallback, label, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    fail(label + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
  }
  return selected;
}
function language(value, label) {
  const selected = text(value, label, 40);
  try {
    const [canonical] = Intl.getCanonicalLocales(selected);
    if (!canonical) fail(label + ' must be a language tag.');
    return canonical;
  } catch { fail(label + ' must be a valid BCP-47 language tag.'); }
}
function httpUrl(value, label) {
  let url;
  try { url = new URL(text(value, label, 4096)); } catch { fail(label + ' must be a valid URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail(label + ' requires HTTPS, except for local loopback development.');
  }
  if (url.username || url.password || url.search || url.hash) fail(label + ' cannot contain credentials, query parameters, or a fragment.');
  return url;
}
function localPath(value, baseDirectory, label) {
  const selected = text(value, label, 4096);
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(selected) || selected.startsWith('\\\\') || selected.startsWith('//')) fail(label + ' must be a local filesystem path.');
  return path.resolve(baseDirectory, selected);
}
export async function readJson(filePath, label) {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) fail(label + ' must be a JSON file no larger than 64 KiB.');
    const contents = await readFile(filePath);
    if (contents.length > MAX_JSON_BYTES) fail(label + ' exceeds 64 KiB.');
    return JSON.parse(contents.toString('utf8').replace(/^\uFEFF/u, ''));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    // Native errors may contain credential-bearing filenames or JSON fragments.
    fail(label + ' could not be read as JSON.');
  }
}
export function validateScenario(raw, selectedLanguage) {
  object(raw, SCENARIO_KEYS, 'Scenario');
  const id = text(raw.id, 'Scenario id', 64);
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(id)) fail('Scenario id must contain lowercase letters, numbers, underscores, or hyphens.');
  const scenarioLanguage = language(raw.language, 'Scenario language');
  if (scenarioLanguage !== selectedLanguage) fail('Scenario language must match the configured test language.');
  const openingQuestion = text(raw.openingQuestion, 'Opening question', 2000);
  if (!Array.isArray(raw.goals) || raw.goals.length < 1 || raw.goals.length > 12) fail('Scenario requires between one and twelve goals.');
  const goals = raw.goals.map((goal) => text(goal, 'Scenario goal', 1000));
  if (raw.expectedFacts !== undefined && (!Array.isArray(raw.expectedFacts) || raw.expectedFacts.length > 20)) fail('Expected facts require at most twenty fixture phrases.');
  const expectedFacts = (raw.expectedFacts ?? []).map((fact) => text(fact, 'Expected fact', 400));
  return Object.freeze({ id, language: scenarioLanguage, openingQuestion, goals: Object.freeze(goals), expectedFacts: Object.freeze(expectedFacts) });
}
export function resolveConfiguration(raw, { baseDirectory = process.cwd(), environment = process.env } = {}) {
  object(raw, CONFIG_KEYS, 'Configuration');
  if (raw.recordAudio !== undefined && typeof raw.recordAudio !== 'boolean') fail('recordAudio must be a boolean.');
  if (raw.agentTestLink != null && raw.agentTestLinkEnv != null) fail('Use agentTestLink or agentTestLinkEnv, not both.');
  let link = raw.agentTestLink;
  if (raw.agentTestLinkEnv != null) {
    const name = text(raw.agentTestLinkEnv, 'Agent link environment variable', 100);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) fail('Agent link environment variable name is invalid.');
    link = environment[name];
    if (!link) fail('The configured agent link environment variable is missing.');
  }
  const testUrl = httpUrl(link, 'Agent test link');
  const match = testUrl.pathname.match(/^\/test\/([A-Za-z0-9_-]{32,128})\/?$/u);
  if (!match) fail('Agent test link must use /test/ followed by a valid share token.');
  const apiUrl = raw.apiBaseUrl == null
    ? new URL('/api', testUrl.origin) : httpUrl(raw.apiBaseUrl, 'API base URL');
  if (apiUrl.origin !== testUrl.origin) fail('API base URL must use the test link origin; cross-origin routing is not supported in this stage.');
  const apiBaseUrl = apiUrl.toString().replace(/\/+$/u, '');
  return Object.freeze({
    // Sensitive values are never spread into CLI output.
    agentTestLink: testUrl.toString(),
    shareToken: match[1],
    apiBaseUrl,
    language: language(raw.language, 'Test language'),
    scenarioPath: localPath(raw.scenario, baseDirectory, 'Scenario path'),
    maxTurns: integer(raw.maxTurns, 5, 'maxTurns', 1, 20),
    maxDurationSeconds: integer(raw.maxDurationSeconds, 120, 'maxDurationSeconds', 10, 600),
    outputDirectory: localPath(raw.outputDirectory, baseDirectory, 'Output directory'),
    callerConfigPath: raw.callerConfig == null ? null : localPath(raw.callerConfig, baseDirectory, 'Caller config path'),
    recordAudio: raw.recordAudio === true,
    placeholder: testUrl.hostname.endsWith('.invalid') || /REPLACE_WITH/u.test(match[1]),
  });
}
export async function loadConfiguration(configPath, options = {}) {
  const absolutePath = path.resolve(options.cwd ?? process.cwd(), configPath);
  const raw = await readJson(absolutePath, 'Configuration');
  const config = resolveConfiguration(raw, {
    baseDirectory: path.dirname(absolutePath), environment: options.environment ?? process.env,
  });
  const scenario = validateScenario(await readJson(config.scenarioPath, 'Scenario'), config.language);
  return Object.freeze({ config, scenario });
}
export function dryRunSummary({ config, scenario }) {
  // Allowlist fields: never serialize raw configuration, URLs, tokens, prompts, or native exceptions.
  return {
    stage: 'transport-caller-reporting',
    mode: 'dry-run',
    networkRequests: 0,
    sessionsCreated: 0,
    toolsExecuted: 0,
    filesWritten: 0,
    liveAudioImplemented: false,
    transportImplemented: true,
    automatedCallerImplemented: true,
    reportingImplemented: true,
    liveTestRun: false,
    language: config.language,
    scenarioId: scenario.id,
    scenarioGoalCount: scenario.goals.length,
    maxTurns: config.maxTurns,
    maxDurationSeconds: config.maxDurationSeconds,
    routing: 'same-origin API prefix preserved',
    outputDirectoryStatus: 'resolved; not created or written',
    warnings: [
      ...(config.placeholder ? ['Placeholder link: this validates offline configuration only.'] : []),
      'Provider credentials, supported speech models, target answers, and deployed routing are not verified.',
      'Live tests may invoke actual tools and incur AI usage; this stage performs neither.',
    ],
    nextStage: 'Live acceptance requires verified caller configuration and explicit permission for session records.',
  };
}

