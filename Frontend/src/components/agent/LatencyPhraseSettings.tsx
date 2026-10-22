import React from 'react';
import { VoiceAgent } from '../../types';
const languages = [['ta','Tamil / Tanglish'],['en','English'],['hi','Hindi'],['te','Telugu'],['kn','Kannada'],['ml','Malayalam'],['bn','Bengali'],['mr','Marathi'],['gu','Gujarati'],['pa','Punjabi'],['es','Spanish'],['fr','French'],['de','German'],['ar','Arabic'],['ur','Urdu']];
export function LatencyPhraseSettings({agent,onChange,disabled}:{agent:VoiceAgent;onChange:(value:Partial<VoiceAgent>)=>void;disabled:boolean}) {
 const groups=agent.latencyPhraseGroups ?? [];
 const update=(index:number,value:Partial<typeof groups[number]>)=>onChange({latencyPhraseGroups:groups.map((group,i)=>i===index?{...group,...value}:group)});
 return <div className="mt-3 space-y-3 text-xs">
  <label className="flex items-center gap-2 font-bold"><input type="checkbox" disabled={disabled} checked={agent.latencySingleEnabled !== false} onChange={e=>onChange({latencySingleEnabled:e.target.checked,...(e.target.checked?{latencyMultipleEnabled:false}:{})})}/>Single acknowledgement</label>
  <label className="flex items-center gap-2 font-bold"><input type="checkbox" disabled={disabled} checked={agent.latencyMultipleEnabled === true} onChange={e=>onChange({latencyMultipleEnabled:e.target.checked,...(e.target.checked?{latencySingleEnabled:false}:{})})}/>Multiple acknowledgements by language</label>
  {agent.latencyMultipleEnabled && <div className="space-y-3">
   <label className="block">Frequency<select className="ml-2 rounded border p-2" disabled={disabled} value={agent.latencyPhraseInterval ?? 2} onChange={e=>onChange({latencyPhraseInterval:e.target.value==='random'?'random':Number(e.target.value)})}>{Array.from({length:20},(_,i)=><option key={i+1} value={i+1}>{i===0?'Every eligible search':`Every ${i+1} eligible searches`}</option>)}<option value="random">Random chance (50%)</option></select></label>
   {groups.map((group,index)=><div key={index} className="rounded border bg-white p-3 space-y-2">
    <select aria-label={`Phrase language ${index+1}`} disabled={disabled} value={group.language} onChange={e=>update(index,{language:e.target.value})} className="rounded border p-2">{languages.map(([code,label])=><option key={code} value={code}>{label}</option>)}</select>
    <button type="button" disabled={disabled} onClick={()=>onChange({latencyPhraseGroups:groups.filter((_,i)=>i!==index)})} className="ml-3 text-red-600">Remove language</button>
    <textarea aria-label={`Acknowledgement phrases ${group.language}`} rows={3} disabled={disabled} value={group.phrases.join('\n')} onChange={e=>update(index,{phrases:e.target.value.split('\n')})} placeholder="One phrase per line" className="w-full rounded border p-2"/>
    <p className="text-[10px] text-slate-500">One phrase per line. Maximum 20 phrases, 200 characters each. Use neutral wording suitable for any search.</p>
   </div>)}
   <button type="button" disabled={disabled || groups.length>=10 || languages.every(([code])=>groups.some(g=>g.language===code))} onClick={()=>onChange({latencyPhraseGroups:[...groups,{language:languages.find(([code])=>!groups.some(g=>g.language===code))![0],phrases:[]}]})} className="rounded border px-3 py-2">Add language</button>
   <p className="text-[10px] text-slate-500">Random phrase, no immediate repeat when possible. Uses the call response language; unmatched languages are skipped. Counts eligible SEARCH turns per call, not all replies. The existing delay and cancellation rules still apply.</p>
  </div>}
  <p className="text-[10px] text-slate-500">Only one mode can be on. Turn both off for no latency acknowledgements. Existing single-message text is retained.</p>
 </div>;
}
