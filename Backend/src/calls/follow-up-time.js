import { resolveCustomerCallbackRequest } from '../campaigns/customer-callback.service.js';

export function resolveRelativeFollowUp(text, options={}) {
  const value=String(text??'').normalize('NFKC');
  if (/(?:don't|do not|never|not now).*call|cancel|ரத்து|வேண்டாம்/iu.test(value)) return {detected:false,resolved:false};
  return resolveCustomerCallbackRequest(value.replace(/remind me/iu,'call me back'),options);
}
export function resolveLocalFollowUp(date,time,zone) {
  if(typeof zone!=='string'||!zone.trim())return {resolved:false,reason:'invalid_timezone'};
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date??'') || !/^\d{2}:\d{2}$/.test(time??''))return {resolved:false,reason:'date_time_required'};
  let formatter;
  try { formatter=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}); }
  catch { return {resolved:false,reason:'invalid_timezone'}; }
  const fields=value=>Object.fromEntries(formatter.formatToParts(new Date(value)).filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
  const [year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);
  const local=Date.UTC(year,month-1,day,hour,minute);
  if(new Date(local).toISOString().slice(0,16)!==`${date}T${time}`)return {resolved:false,reason:'invalid_date_time'};
  const offsets=new Set();
  for(let hours=-36;hours<=36;hours+=6){
    const sample=local+hours*3600000,part=fields(sample);
    offsets.add(Date.UTC(+part.year,+part.month-1,+part.day,+part.hour,+part.minute,+part.second)-sample);
  }
  const candidates=[...offsets].map(offset=>local-offset).filter(value=>{
    const part=fields(value);return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}`===`${date}T${time}`;
  });
  if(candidates.length!==1)return {resolved:false,reason:candidates.length?'ambiguous_dst_time':'nonexistent_dst_time'};
  return {resolved:true,requestedFor:new Date(candidates[0]).toISOString(),timeZone:zone};
}
