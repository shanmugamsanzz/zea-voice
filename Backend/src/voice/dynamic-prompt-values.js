import { withPlatformAdminContext } from '../infrastructure/database-context.js';

export const dynamicPromptKeys = Object.freeze([
  'contact.name','contact.phone','call.direction','call.purpose',
  'conversation.is_returning','conversation.recent_summaries','conversation.latest_summary',
  'conversation.last_outcome','conversation.pending_questions','conversation.last_call_at',
  'callback.reason','callback.status','callback.scheduled_for','callback.requested_at',
  'current.datetime','current.timezone',
]);
const keys = new Set(dynamicPromptKeys);
const pattern = /{{\s*([A-Za-z][A-Za-z0-9_.-]{0,63})\s*}}/g;
const clean = (value, max = 1000) => Array.from(String(value ?? '').normalize('NFC')
  .replace(/[\p{Cc}\p{Cf}]/gu,' ').replace(/\s+/g,' ').trim()).slice(0,max).join('');

export function hasDynamicPromptValues(prompt) {
  return [...String(prompt ?? '').matchAll(pattern)].some(match => keys.has(match[1]));
}

export function buildDynamicPromptValues({ call = {}, contact, summaries = [], followUp,
  summaryCount = 2, summaryMaxChars = 6000, timeZone = 'UTC', now = new Date() } = {}) {
  let zone = timeZone;
  try { new Intl.DateTimeFormat('en',{timeZone:zone}).format(now); } catch { zone = 'UTC'; }
  let remaining = Math.min(20000,Math.max(0,Number(summaryMaxChars) || 0));
  const recent = summaries.slice(0,Math.min(10,Math.max(0,Number(summaryCount) || 0))).flatMap(summary => {
    const text = clean(summary.summary_text,remaining);
    remaining -= Array.from(text).length;
    return text ? [text] : [];
  });
  const latest = summaries.find(summary => clean(summary.summary_text));
  const phone = call.providerMetadata?.source === 'browser_test' ? ''
    : call.direction === 'inbound' ? call.fromNumber : call.direction === 'outbound' ? call.toNumber : '';
  return Object.freeze({
    'contact.name': clean(contact?.display_name,240),
    'contact.phone': /^\+[1-9][0-9]{6,14}$/.test(phone ?? '') ? phone : '',
    'call.direction': ['inbound','outbound'].includes(call.direction) ? call.direction : 'unknown',
    'call.purpose': clean(followUp?.current_attempt ? followUp.purpose : call.callPurpose,1000) || 'unknown',
    'conversation.is_returning': Boolean(contact?.has_prior_conversation),
    'conversation.recent_summaries': recent.join('\n\n'),
    'conversation.latest_summary': recent[0] ?? '',
    'conversation.last_outcome': recent.length ? clean(latest?.outcome,240) : '',
    'conversation.pending_questions': recent.length ? clean(
      Array.isArray(latest?.collected_data?.pending_questions)
        ? latest.collected_data.pending_questions.filter(value=>typeof value==='string').join('; ')
        : typeof latest?.collected_data?.pending_questions==='string' ? latest.collected_data.pending_questions : '',1000) : '',
    'conversation.last_call_at': contact?.last_call_at ? new Date(contact.last_call_at).toISOString() : '',
    'callback.reason': clean(followUp?.purpose,1000),
    'callback.status': clean(followUp?.status,40),
    'callback.scheduled_for': followUp?.scheduled_for ? new Date(followUp.scheduled_for).toISOString() : '',
    'callback.requested_at': followUp?.created_at ? new Date(followUp.created_at).toISOString() : '',
    'current.datetime': new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'full',timeStyle:'long'}).format(now),
    'current.timezone': zone,
  });
}

// One-pass, allowlisted substitution; values are JSON data, never evaluated templates.
export function renderDynamicPrompt(prompt, values, maximumChars = 40000) {
  const source = String(prompt ?? '');
  if (!hasDynamicPromptValues(source)) return { text:source, resolvedVariables:[] };
  const baseline = source.replace(pattern,(match,key)=>keys.has(key) ? '""' : match);
  let budget = Math.max(0,maximumChars-Array.from(baseline).length);
  const resolved = new Set();
  const text = source.replace(pattern,(match,key)=> {
    if (!keys.has(key)) return match;
    resolved.add(key);
    const value = Object.hasOwn(values,key) ? values[key] : '';
    let encoded = JSON.stringify(value ?? '');
    if (Array.from(encoded).length > budget+2) {
      const chars = Array.from(String(value ?? ''));
      let low = 0, high = Math.min(chars.length,budget);
      while (low < high) {
        const middle = Math.ceil((low+high)/2);
        if (Array.from(JSON.stringify(chars.slice(0,middle).join(''))).length <= budget+2) low=middle;
        else high=middle-1;
      }
      encoded = JSON.stringify(chars.slice(0,low).join(''));
    }
    budget -= Math.max(0,Array.from(encoded).length-2);
    return encoded;
  });
  return {text,resolvedVariables:[...resolved]};
}

export async function loadDynamicPromptValues(call, agent, dependencies = {}) {
  const runner = dependencies.contextRunner ?? (operation => withPlatformAdminContext(null,operation));
  const defaults = {call,summaryCount:agent.previousSummaryCount ?? 2,
    summaryMaxChars:agent.previousSummaryMaxChars ?? 6000,timeZone:agent.timeZone ?? 'UTC',now:dependencies.now ?? new Date()};
  if (call.providerMetadata?.source === 'browser_test') return buildDynamicPromptValues(defaults);
  return runner(async client => {
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    // Read recipient and purpose from the persisted call, never caller-supplied template fields.
    const result = await client.query(`SELECT c.direction,c.from_number,c.to_number,c.provider_metadata,
        l.conversation_id,l.call_purpose,ct.id AS contact_id,ct.display_name,
        EXISTS(SELECT 1 FROM conversation_call_links pl JOIN call_sessions pc ON pc.id=pl.call_session_id
          AND pc.tenant_id=pl.tenant_id WHERE pl.tenant_id=c.tenant_id AND pl.conversation_id=cv.id
          AND pc.id<>c.id AND pc.answered_at IS NOT NULL AND pc.started_at<c.started_at) AS has_prior_conversation,
        (SELECT max(pc.started_at) FROM conversation_call_links pl JOIN call_sessions pc ON pc.id=pl.call_session_id
          AND pc.tenant_id=pl.tenant_id WHERE pl.tenant_id=c.tenant_id AND pl.conversation_id=cv.id
          AND pc.id<>c.id AND pc.answered_at IS NOT NULL AND pc.started_at<c.started_at) AS last_call_at
      FROM call_sessions c
      LEFT JOIN conversation_call_links l ON l.call_session_id=c.id AND l.tenant_id=c.tenant_id
      LEFT JOIN conversation_contacts ct ON ct.tenant_id=c.tenant_id AND ct.phone_e164=
        CASE WHEN c.direction='inbound' THEN c.from_number ELSE c.to_number END
      LEFT JOIN contact_conversations cv ON cv.tenant_id=ct.tenant_id AND cv.contact_id=ct.id
      WHERE c.id=$1 AND c.tenant_id=$2 AND c.workspace_id=$3`,[call.id,call.tenantId,call.workspaceId]);
    if (!result.rowCount) return buildDynamicPromptValues({...defaults,call:{}});
    const row = result.rows[0];
    if (row.provider_metadata?.source === 'browser_test') return buildDynamicPromptValues({...defaults,call:{...call,providerMetadata:row.provider_metadata}});
    const count = Math.min(10,Math.max(0,Number(defaults.summaryCount)));
    const summaries = count && row.contact_id ? await client.query(`SELECT s.summary_text,s.outcome,s.collected_data
      FROM call_ai_summaries s JOIN call_sessions pc ON pc.id=s.call_session_id AND pc.tenant_id=s.tenant_id
      JOIN conversation_call_links pl ON pl.call_session_id=pc.id AND pl.tenant_id=pc.tenant_id
      JOIN contact_conversations cv ON cv.id=pl.conversation_id AND cv.tenant_id=pl.tenant_id
      WHERE cv.contact_id=$1 AND cv.tenant_id=$2 AND s.status='completed' AND pc.answered_at IS NOT NULL
        AND pc.id<>$3 AND pc.started_at<(SELECT started_at FROM call_sessions WHERE id=$3 AND tenant_id=$2)
      ORDER BY pc.started_at DESC,pc.id DESC LIMIT $4`,[row.contact_id,call.tenantId,call.id,count]) : {rows:[]};
    const followUp = await client.query(`SELECT t.purpose,t.status,t.scheduled_for,t.created_at,
        (a.call_session_id=$1) AS current_attempt
      FROM scheduled_follow_up_tasks t LEFT JOIN follow_up_call_attempts a ON a.follow_up_task_id=t.id
        AND a.tenant_id=t.tenant_id AND a.workspace_id=t.workspace_id
      JOIN call_sessions c ON c.id=$1 AND c.tenant_id=t.tenant_id AND c.workspace_id=t.workspace_id
      WHERE t.tenant_id=$2 AND t.workspace_id=$3 AND (a.call_session_id=$1 OR
        ((t.status IN ('scheduled','queued') OR
          (c.direction='inbound' AND t.status IN ('no_answer','busy','failed') AND t.finished_at>=now()-interval '7 days'))
          AND EXISTS(SELECT 1 FROM contact_conversations cv
          WHERE cv.id=t.conversation_id AND cv.tenant_id=t.tenant_id AND cv.contact_id=$4)))
      ORDER BY (a.call_session_id=$1) DESC NULLS LAST,
        (t.status IN ('scheduled','queued')) DESC,
        CASE WHEN t.status IN ('scheduled','queued') THEN t.scheduled_for END,
        t.finished_at DESC NULLS LAST,t.id LIMIT 1`,[call.id,call.tenantId,call.workspaceId,row.contact_id ?? null]);
    return buildDynamicPromptValues({...defaults,call:{...call,direction:row.direction,fromNumber:row.from_number,
      toNumber:row.to_number,providerMetadata:row.provider_metadata,callPurpose:row.call_purpose},
      contact:row,summaries:summaries.rows,followUp:followUp.rows[0]});
  });
}
