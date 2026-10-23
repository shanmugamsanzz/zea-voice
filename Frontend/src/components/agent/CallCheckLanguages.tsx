import React, { useState } from 'react';
const languages=[['en','English'],['ta','Tamil / Tanglish'],['hi','Hindi'],['te','Telugu'],['kn','Kannada'],['ml','Malayalam'],['bn','Bengali'],['mr','Marathi'],['gu','Gujarati'],['pa','Punjabi'],['es','Spanish'],['fr','French'],['de','German'],['ar','Arabic'],['ur','Urdu'],['ja','Japanese'],['zh','Chinese'],['ko','Korean'],['pt','Portuguese'],['ru','Russian']];
export function CallCheckLanguages({value,onChange,disabled}:{value:Record<string,string>;onChange:(value:Record<string,string>)=>void;disabled:boolean}) {
 const [language,setLanguage]=useState('en');
 return <div className="mt-3 space-y-2 text-xs">
  <label className="block font-bold">Language-specific Call Check Response (optional)</label>
  <select aria-label="Call Check response language" disabled={disabled} value={language} onChange={e=>setLanguage(e.target.value)} className="rounded border p-2">{languages.map(([code,label])=><option key={code} value={code}>{label}{value[code]?.trim()?' (configured)':''}</option>)}</select>
  <textarea aria-label={`Call Check response ${language}`} rows={2} maxLength={500} disabled={disabled} value={value[language] ?? ''} onChange={e=>onChange({...value,[language]:e.target.value})} placeholder="Brief presence acknowledgement; do not introduce the agent again." className="w-full rounded border p-3"/>
  <p className="text-[10px] text-slate-500">Matches the call's saved response language. The original response remains the default-language fallback. If a switched language has no configured text, the normal LLM responds in that language. Clear this field to remove an override.</p>
 </div>;
}
