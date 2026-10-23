import { withPlatformAdminContext } from '../../infrastructure/database-context.js';
export function callerNameInstruction({name='',asked=false}={}) {
  const known=typeof name==='string'?name.trim():'';
  return `Per-call caller-name state (independent of history): savedCallerName=${JSON.stringify(known || null)}, optionalNameAsked=${asked}. ${known ? 'The caller name is already saved. Never ask their name again.' : asked ? 'The optional caller-name question was already asked this call. Do not ask again, even after refusal, unclear reply or history trimming. Continue helping.' : 'No saved caller name. At the next natural early pause, ask their own name once, politely and without pressure, even for returning callers. Answer their direct question first; outbound speaking consent comes first. Skip for emergency, transfer, refusal or goodbye.'} Set callerNameAsked=true ONLY if THIS speech asks for the caller own name, otherwise false. A patient-name question for another person is separate. Save a clear caller own-name response with update_contact as authorized; never save a different patient name as caller name. Missing optional caller name must not block help.`;
}

export async function loadSavedCallerName(call, dependencies={}) {
  const runner=dependencies.contextRunner ?? (operation=>withPlatformAdminContext(null,operation));
  return runner(async client=>{
    await client.query("SET LOCAL statement_timeout = '1000ms'");
    const result=await client.query(`SELECT ct.display_name FROM call_sessions c
      LEFT JOIN conversation_contacts ct ON ct.tenant_id=c.tenant_id AND ct.phone_e164=
        CASE WHEN c.direction='inbound' THEN c.from_number WHEN c.direction='outbound' THEN c.to_number END
      WHERE c.id=$1 AND c.tenant_id=$2 AND c.workspace_id=$3
        AND COALESCE(c.provider_metadata->>'source','')<>'browser_test'`,[call.id,call.tenantId,call.workspaceId]);
    return result.rows[0]?.display_name ?? '';
  });
}
