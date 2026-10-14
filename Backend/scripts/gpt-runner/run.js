import { pathToFileURL } from 'node:url';
import { ConfigurationError, loadConfiguration, dryRunSummary } from './config.js';
import { RunnerError } from './errors.js';

const HELP = [
  'GPT Runner - isolated automated caller',
  '',
  'Usage: node scripts/gpt-runner/run.js --config <local.json> --dry-run',
  '       node scripts/gpt-runner/run.js --config <local.json> --live --allow-session-records',
  '       node scripts/gpt-runner/run.js --help',
  '',
  'Dry-run validates local configuration only; no network or output files.',
  'Live mode requires explicit permission for normal test-session database records.',
  'Live calls execute existing tools and consume AI usage. No schema changes are made.',
].join('\n');
export function parseArguments(args) {
  let configPath = null; let dryRun = false; let help = false; let live = false; let allowSessionRecords = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--dry-run' && !dryRun) dryRun = true;
    else if (argument === '--live' && !live) live = true;
    else if (argument === '--allow-session-records' && !allowSessionRecords) allowSessionRecords = true;
    else if (argument === '--config' && configPath === null) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new ConfigurationError('--config requires one local file path.');
      configPath = value;
    } else throw new ConfigurationError('Unknown or duplicate CLI option.');
  }
  return { configPath, dryRun, help, live, allowSessionRecords };
}
export async function main(args = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr, load = loadConfiguration, execute } = {}) {
  try {
    const options = parseArguments(args);
    if (options.help) { stdout.write(HELP + '\n'); return 0; }
    if (options.dryRun && (options.live || options.allowSessionRecords)) throw new ConfigurationError('Dry-run cannot be combined with live permissions.');
    if (!options.dryRun && (!options.live || !options.allowSessionRecords)) {
      throw new ConfigurationError('Live execution requires --live and --allow-session-records. Otherwise use --dry-run.');
    }
    if (!options.configPath) throw new ConfigurationError('Provide --config with a local JSON configuration.');
    const settings = await load(options.configPath);
    if (options.dryRun) { stdout.write(JSON.stringify(dryRunSummary(settings), null, 2) + '\n'); return 0; }
    if (settings.config.placeholder || !settings.config.callerConfigPath) throw new ConfigurationError('Live execution requires a real test link and local callerConfig.');
    const result = await (execute ?? executeLive)(settings);
    stdout.write(JSON.stringify({ mode: 'live', liveTestVerified: result.report.liveTestVerified,
      generatedTurns: result.report.generatedTurns, failureCode: result.report.failure?.code ?? null,
      cleanup: result.report.cleanup, reportSaved: true }, null, 2) + '\n');
    return result.report.failure || result.report.cleanup !== 'requested' ? 1 : 0;
  } catch (error) {
    const message = error instanceof ConfigurationError || error instanceof RunnerError ? error.message : 'Operation failed; private error details were omitted.';
    stderr.write('GPT Runner: ' + message + '\n'); return 2;
  }
}
async function executeLive({ config, scenario }) {
  const [{ createConfiguredCaller }, { runConversation }, { writeReport }] = await Promise.all([
    import('./caller.js'), import('./conversation.js'), import('./report.js'),
  ]);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const timer = setTimeout(stop, config.maxDurationSeconds * 1000);
  let caller;
  try {
    caller = await createConfiguredCaller(scenario, config.callerConfigPath);
    const result = await runConversation({ config, scenario, caller, allowSessionRecords: true, signal: controller.signal });
    await writeReport(config.outputDirectory, result.report, { incoming: result.incoming, outgoing: result.outgoing, recordAudio: config.recordAudio });
    return result;
  } finally {
    clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await caller?.close().catch(() => {});
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
