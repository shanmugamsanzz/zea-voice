import fs from 'node:fs/promises';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const cases = [
['Call connection & audio','P0','Inbound call','Call the assigned inbound number; speak and listen.','Agent answers; both sides hear clearly; correct agent is used.'],
['Call connection & audio','P0','Outbound and unanswered calls','Trigger outbound tests: answer one; leave one unanswered; reject one.','Correct destination; answered/no-answer/busy or provider-supported result recorded.'],
['Call connection & audio','P0','Hangup and capacity release','Test caller hangup, requested agent hangup, and authorized forced hangup.','Call ends; final status recorded; capacity released; no stuck call.'],
['Call connection & audio','P1','Recording and transcript','Download the recording and compare caller/agent speech with the transcript.','Audio is accessible only to authorized accounts; both sides captured; no unexplained omissions.'],
['Conversation flow','P1','Exact question and correction','Ask only the doctor name; correct the agent if it adds unwanted details.','Answers the exact question briefly; correction respected; no repeated unwanted response.'],
['Conversation flow','P1','Short replies and presence checks','Say yes/okay after agreeing to talk; say Hello during an ongoing conversation.','Interprets reply against last question; does not restart greeting or ask permission repeatedly.'],
['Conversation flow','P0','Long speech and interruption','Speak a long sentence with natural pauses; interrupt the agent; remain silent while it speaks.','No premature turn completion; real interruption handled; no false user speech or repeated audio.'],
['Conversation flow','P1','Tamil/Tanglish and closing','Speak natural Tamil/Tanglish; say no further help is needed.','Natural configured language; no name repeated every turn; agent closes without repeated questions.'],
['Knowledge & pricing','P0','Known service facts','Ask doctor name, hospital location, and supported services. Compare with approved KB.','Answers agree with approved KB; no invented services, experience or capabilities.'],
['Knowledge & pricing','P0','Current consultation fee','Ask current fee and what it covers; compare with configured live data.','Verified current amount, unit and exclusions; no historical or invented price.'],
['Knowledge & pricing','P0','Missing information','Ask a price or service detail absent from configured sources.','Clearly states uncertainty; does not fabricate facts or promise unsupported actions.'],
['Knowledge & pricing','P1','Developer answer sources','Check source details for factual answers as Developer; compare with retrieved content.','Sources support the answer; unexpected missing/wrong sources logged for investigation.'],
['Contact & history','P1','New name and returning greeting','State your own name; finish call; call again from the same number.','Verified name appears in conversation; returning greeting uses it once; no repeated name question.'],
['Contact & history','P1','Correct stored name','Say the stored name is wrong and provide your own corrected name.','Authorized update saves corrected name; later calls use it; no repeated correction loop.'],
['Contact & history','P0','Another patient','Request an appointment for a relative and provide their patient name.','Patient name retained for request; caller profile is not overwritten with relative name.'],
['Contact & history','P1','Reuse history and report name','Return with known name, phone and location; inspect conversation and Report Contact Name.','Briefly verifies known details; asks only missing fields; report name matches saved contact (log mismatch as defect).'],
['Appointment/actions','P0','Complete appointment intake','Request appointment; supply missing concern, visit preference, date and time; approve submission.','All required fields retained; configured submission verified; request is not falsely called a confirmed booking.'],
['Appointment/actions','P1','Interrupt and resume intake','Answer one intake field; ask service/fee question; then continue appointment request.','Answers interruption and resumes next missing field; never restarts intake.'],
['Appointment/actions','P1','Contact update during intake','Provide your own name during intake so update_contact executes; continue with location.','Tool completion retains goal and supplied fields; no premature anything-else closing.'],
['Appointment/actions','P0','Unavailable or failed action','Test missing submission tool or controlled tool failure in staging.','No claim of booking, saving, staff notification or delivery without verified success.'],
['Callback','P0','Relative callback','Request callback after 2 minutes while busy. Observe tool result, queue and call.','Exactly one saved task; one closing; hangup after playback; dispatch when due and eligible.'],
['Callback','P0','Change or cancel callback','Schedule callback; correct the time; separately test cancellation.','Latest request wins; no duplicate active callback; canceled task never dials.'],
['Callback','P0','Caller hangup and restart','Request callback; hang up after saved success. Restart worker before due time in staging.','Saved task survives hangup/restart; eligible callback dispatches once; no duplicate dialing.'],
['Callback','P1','Missed callback then inbound','Do not answer callback; call inbound afterward.','Uses verified history/current purpose; does not claim missed call was answered or task was saved from summary alone.'],
['Campaign & queue','P0','CSV destination accuracy','Upload known test contacts; inspect preview, import payload, tasks and dialed numbers.','Every queued/dialed number matches uploaded data; no old template contacts.'],
['Campaign & queue','P1','Invalid and duplicate rows','Import invalid numbers and duplicate phone rows; compare import counts with configured policy.','Invalid rows rejected visibly; duplicate policy applied consistently; counts reconcile.'],
['Campaign & queue','P0','100 leads with limit 2','Set company/campaign limit 2; inbound queue 100; outbound queue 1000; upload 100 authorized test leads.','At most 2 shared active calls; eligible remainder waits; slots reused; no loss/duplicates.'],
['Campaign & queue','P0','Schedule, controls and mixed traffic','Test schedule/timezone/retries; pause/resume/cancel; add inbound traffic; test wait limit.','No out-of-window campaign dialing; canceled tasks stay canceled; shared limit respected; configured waiting/timeout works.'],
['Reports, billing & access','P0','Call artifacts and outcomes','Compare final call status, transcript, recording, summary and verified tool outcomes.','Records match actual call; summary does not establish unsupported booking/callback success.'],
['Reports, billing & access','P0','Billing and duplicate events','Use known-duration calls; reconcile configured rates/Plivo rounding; replay callback in staging.','Expected cost and balance; no duplicate debit; distinguish platform charges from provider charges.'],
['Reports, billing & access','P0','Role and tab restrictions','Test User/Developer; disable tabs; attempt direct API access; test all tabs off and re-login.','Allowed tabs only; disabled actions denied; User cannot see cost/sources; existing role boundaries preserved.'],
['Reports, billing & access','P0','Company isolation and low credits','Use two companies; attempt cross-company IDs; exhaust test credits while tasks wait.','No cross-company records/actions; credit policy enforced; no unauthorized or duplicate calls.'],
];
const wb = Workbook.create();
const s = wb.worksheets.add('Core Tests');
s.showGridLines = false;
s.tabColor = '#202320';
s.getRange('A2').values = [['Zea Voice | Beta 1 core test checklist']];
s.getRange('A2').format.font = { name: 'Arial', size: 16, bold: true, color: '#202320' };
s.getRange('A3').values = [['P0 = release blocker; P1 = core behavior. Record evidence for every failure. Use staging and authorized test numbers.']];
s.getRange('A4').values = [['Set Status and capture actual result, tester, test time (IST), call/task ID, and issue/evidence link. All cases start Not Started.']];
const headers=['Test ID','Core area','Priority','Scenario','Test steps','Expected result','Status','Actual result / notes','Tester','Test date/time (IST)','Call / campaign / task ID','Issue / evidence link'];
s.getRange('A6:L6').values=[headers];
const rows=cases.map((c,i)=>[`CORE-${String(i+1).padStart(2,'0')}`,...c,'Not Started','','','','','']);
const last=rows.length+6;
s.getRange(`A7:L${last}`).values=rows;
s.getRange(`A6:L${last}`).format.font={name:'Arial',size:11,color:'#202320'};
s.getRange(`A7:L${last}`).format.wrapText=true;
s.getRange(`A7:L${last}`).format.verticalAlignment='top';
s.getRange(`A7:L${last}`).format.rowHeight=64;
s.getRange('A6:L6').format={fill:'#202320',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},wrapText:true,horizontalAlignment:'center',verticalAlignment:'center',rowHeight:34};
const widths=[13,25,9,30,62,65,17,42,20,25,38,42];
widths.forEach((w,i)=>s.getRange(`${String.fromCharCode(65+i)}6:${String.fromCharCode(65+i)}${last}`).format.columnWidth=w);
for(let r=7;r<=last;r++){
  if((r-7)%4===0)s.getRange(`A${r}:L${r}`).format.borders={top:{style:'medium',color:'#DFA822'}};
  if(r%2===0)s.getRange(`A${r}:F${r}`).format.fill='#F5F6F5';
}
s.getRange(`G7:L${last}`).format.fill='#FFF8E5';
s.getRange(`G7:G${last}`).dataValidation={rule:{type:'list',values:['Not Started','In Progress','Pass','Fail','Blocked','Not Applicable']}};
for(const [value,fill,color] of [['Pass','#E8F3EC','#17603A'],['Fail','#FDE8E8','#9B1C1C'],['Blocked','#FFF1CB','#805A00']]){
  s.getRange(`G7:G${last}`).conditionalFormats.add('containsText',{text:value,format:{fill,font:{color,bold:true}}});
}
const table = s.tables.add(`A6:L${last}`,true,'CoreTestChecklist');
table.style = 'TableStyleLight1';
s.freezePanes.freezeRows(6);
s.freezePanes.freezeColumns(2);
wb.recalculate();
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#NUM!',options:{useRegex:true,maxResults:10},maxChars:500})).ndjson);
console.log((await wb.inspect({kind:'table',range:'Core Tests!A6:G10',include:'values',tableMaxRows:5,tableMaxCols:7,maxChars:2300})).ndjson);
if(s.getRange(`A7:A${last}`).values.length!==32)throw new Error('Incorrect test count');
const preview=await wb.render({sheetName:'Core Tests',range:'A6:G10',scale:1,format:'png'});
await fs.writeFile(new URL('./preview.png',import.meta.url),new Uint8Array(await preview.arrayBuffer()));
const xlsx=await SpreadsheetFile.exportXlsx(wb);
await xlsx.save(new URL('./Zea_Voice_Beta1_Core_Test_Checklist.xlsx',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
console.log('Exported 32 core tests across 8 areas.');
