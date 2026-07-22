const levelNames = new Map([
  [10, 'TRACE'], [20, 'DEBUG'], [30, 'INFO '], [40, 'WARN '], [50, 'ERROR'], [60, 'FATAL'],
]);
const hidden = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'req', 'res', 'responseTime']);

function oneLine(value, maximum = 900) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const compact = String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return compact.length > maximum ? `${compact.slice(0, maximum)}...` : compact;
}

function tag(event) {
  if (event.stage?.startsWith('outbound.') || event.stage?.startsWith('voice.')
    || event.stage?.startsWith('call.') || ['stt', 'llm', 'tts'].includes(event.stage)) return 'CALL';
  if (event.req || event.method) return event.msg === 'API performance' ? 'PERF' : 'HTTP';
  if (event.provider) return 'PROVIDER';
  return 'APP';
}

function details(event) {
  const fields = Object.entries(event).filter(([key, value]) => !hidden.has(key) && value != null);
  return fields.map(([key, value]) => `${key}=${oneLine(value)}`).join(' | ');
}

function format(event) {
  const timestamp = new Date(event.time ?? Date.now()).toISOString();
  const level = levelNames.get(event.level) ?? String(event.level ?? 'INFO');
  if (event.req) {
    const status = event.res?.statusCode ?? '-';
    const duration = event.responseTime == null ? '' : ` (${event.responseTime}ms)`;
    const summary = `${event.req.method ?? '?'} ${event.req.url ?? '?'} -> ${status}${duration}`;
    const remainder = details(event);
    return `${timestamp} ${level} [HTTP] ${summary}${remainder ? ` | ${remainder}` : ''}`;
  }
  if (event.msg === 'API performance') {
    const summary = `${event.method ?? '?'} ${event.path ?? '?'} -> ${event.statusCode ?? '-'} (${event.durationMs ?? '?'}ms)`;
    const remainder = details(event);
    return `${timestamp} ${level} [PERF] ${summary}${remainder ? ` | ${remainder}` : ''}`;
  }
  const remainder = details(event);
  return `${timestamp} ${level} [${tag(event)}] ${oneLine(event.msg ?? 'Log event')}${remainder ? ` | ${remainder}` : ''}`;
}

export function createHumanLogStream(output = process.stdout) {
  return {
    write(line) {
      try {
        output.write(`${format(JSON.parse(line))}\n`);
      } catch {
        output.write(`${oneLine(line)}\n`);
      }
    },
  };
}
