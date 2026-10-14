import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
const dir=path.dirname(fileURLToPath(import.meta.url));
const wb=Workbook.create();
const sections=[
['1. BASIC INFORMATION','PROJECT NAME','Zea Voice — multi-company AI voice-agent application. Balaji Robotic Rehab Hospital is the initial testing configuration.'],
['1. BASIC INFORMATION','VERSION','Phase 1 / Beta 1. Exact build number and deployed Git commit: confirm before handover.'],
['1. BASIC INFORMATION','DEVELOPER NAME','Shanmugam / Zea Voice development team. Confirm the full contributor list.'],
['1. BASIC INFORMATION','TESTING HANDOVER DATE','To be confirmed by Project Manager.'],
['1. BASIC INFORMATION','PROJECT MANAGER','To be confirmed.'],
['1. BASIC INFORMATION','PRIORITY','HIGH. Treat wrong-number dialing, unauthorized access, duplicate charges and false action confirmations as release blockers.'],
['2. FEATURE','WHY WAS IT DEVELOPED?','Automate incoming/outgoing customer calls, approved enquiry answers, follow-up requests and company-scoped conversation history.'],
['2. FEATURE','WHAT PROBLEM DOES IT SOLVE?','Missed enquiries, manual calling workload, inconsistent follow-up, scattered contact history and limited visibility into call outcomes.'],
['2. FEATURE','WHO IS THE END USER?','Company Developers configuring agents; Company Users reviewing operational records; Super Admin managing the platform; customers/patients speaking with agents.'],
['2. FEATURE','ACCESSIBILITY ROLES','Actual roles: Super Admin, Company Developer, Company User. Manager/Employee are not separate platform roles. Tab visibility is account-specific where deployed; role restrictions still apply.'],
['3. SCOPE OF TESTING','FEATURES TO BE TESTED','Login and role permissions; agent prompt/voice saves; inbound/outbound audio; KB/live-data answers; interruption; contact/history reuse; configured appointment-request tools; callbacks; batch import; schedules/retries; shared capacity/queues; reports/recordings/billing; share-link expiry/revocation.'],
['3. SCOPE OF TESTING','FEATURES TO BE TESTED LATER','WhatsApp calling, unconfigured CRM/staff notification/transfer workflows, additional languages/provider combinations, and higher concurrency than the approved Beta capacity. Confirm the Phase 1 scope with the PM.'],
['3. SCOPE OF TESTING','ADDITIONAL FEATURES OUTSIDE CLIENT REQUIREMENT','Not established from the conversation. PM/client must confirm scope exclusions; do not classify platform features as extras without approval.'],
['RE-TEST','MODIFIED FEATURES','Post-tool conversation context; contact-name/history reuse; callback scheduling and closing; TTS invalid-content handling; role-specific report visibility; per-account tab access; campaign permanent deletion. Verify each change exists in the deployed build.'],
['RE-TEST','UI CHANGES','Conversation panels and expandable summaries; account tab toggles; permanent campaign-deletion warning with task counts and typed DELETE; User report cost/source visibility.'],
['RE-TEST','BUGS FIXED — VERIFY IN RELEASE','Appointment context lost after update_contact; duplicate pre/post-tool speech; relative callback evidence rejection; punctuation-only acknowledgement TTS failure; old campaign waiting tasks after deletion. These require live regression, not assumed release approval.'],
['RE-TEST','WORKFLOW CHANGES','Reuse known caller details; clarify corrections only; schedule callbacks through verified tools; enforce saved UI controls; permanently remove campaign/tasks only after guarded confirmation.'],
['RE-TEST','FURTHER ENHANCEMENT','Review report contact-name mapping, detailed provider diagnostics, alerting and recovery, retrieval quality, and larger load tests. Confirm backlog and release priorities.'],
['5. ADDITIONAL REQUIREMENTS','DARK / LIGHT / COLOURFUL MODE BUG REPORTING','YES: include a Theme field per issue and test both implemented light/dark modes. Colourful mode: not confirmed; mark Not Applicable unless available in the release. Separate issue only if root causes differ.'],
['5. ADDITIONAL REQUIREMENTS','FAILURE EVIDENCE','Record test ID, steps, expected/actual result, role, company, theme, timestamp (IST), Call/Campaign/Task ID, screenshots and relevant sanitized logs.'],
['5. ADDITIONAL REQUIREMENTS','RELEASE ACCEPTANCE','No unresolved critical access, dialing, billing or action-confirmation failures. Verify migration, backups, rollback and configured provider limits. All deployment checks need recorded evidence.'],
['6. TEST DATA','SAMPLE DEVELOPER LOGIN','Website: https://voice.zeacrm.com/ | Developer email: support@balajiroboticrehab.com. Share the current password separately through an approved secure channel; no password included in this workbook.'],
['6. TEST DATA','SAMPLE COMPANY USER LOGIN','User email: dr.nithya@balajiroboticrehab.com. Confirm active role and assigned company. Share current password separately. Super Admin credentials: obtain from authorized owner.'],
['6. TEST DATA','SAMPLE TASKS','An appointment request interrupted by a fee question; callback after 2 minutes; callback reschedule/cancel; returning contact enquiry; 100 unique authorized test leads with company/campaign concurrency 2.'],
['6. TEST DATA','VALID EXAMPLES','CSV headers: name,phone,remarks. Full E.164 phone stored as text. Use consented team-owned numbers. Test known doctor/service facts, current verified fees and explicit caller-name corrections.'],
['6. TEST DATA','INVALID EXAMPLES','Blank/malformed/scientific-notation phone; duplicate normalized phone; missing phone column; invalid date or ambiguous time; unavailable tool; expired/revoked share link; disabled tab; cross-company ID; insufficient credits.'],
['6. TEST DATA','LOAD / QUEUE SETUP','Company concurrency 2; campaign concurrency 2; inbound waiting capacity 100; outbound waiting capacity 1000. 100 unique valid leads: at most 2 active, remaining eligible tasks wait. Inbound/outbound share slots; schedule/credits/provider limits still apply.'],
['6. TEST DATA','DUPLICATE IMPORT EXPECTATION','100 file rows containing only 2 unique valid phone numbers produce 2 accepted tasks and 98 duplicates. File row count is not accepted-lead count.'],
['6. TEST DATA','SAFETY AND PRIVACY','Use staging where possible, approved test contacts and synthetic patient data. Do not use random generated phone numbers, real medical records or secrets in shared bug reports.'],
];
const sh=wb.worksheets.add('Handover');
sh.showGridLines=false; sh.tabColor='#202320';
sh.getRange('A2').values=[['Zea Voice | Phase 1 Beta testing handover']];
sh.getRange('A3').values=[['Draft based on discussed functionality. Confirm deployed build, ownership, dates and client scope before sign-off.']];
sh.getRange('A5:D5').values=[['Section','Requested information','Answer / testing guidance','Team confirmation / notes']];
sh.getRange(`A6:D${sections.length+5}`).values=sections.map(x=>[...x,'']);
const perms=[
['Platform companies / providers / credits','YES','NO','NO'],
['Create/edit accounts and assign tab access','YES','NO','NO'],
['Company Dashboard / Analytics','YES — company context','YES — if enabled','YES — if enabled'],
['Agent configuration and attached resources','YES — authorized company context','YES — if enabled','Read-only where exposed; no configuration management'],
['Campaign create/edit/pause/delete','YES — company context','YES — if enabled','Read-only; no management'],
['Call Queue viewing','YES — company context','YES — if enabled','YES — if enabled'],
['Cancel waiting tasks / resume campaigns','YES — company context','YES — if enabled','NO'],
['Conversation / transcript / recording access','YES — company context','YES — if enabled','YES — company-scoped, if enabled'],
['Reports: Call Cost / Answer Sources','YES','YES — report access required','NO'],
['Phone-number viewing','YES','YES — if enabled','YES — if enabled'],
['API Keys / Settings / Integrations tabs','YES — applicable administrative access','YES — if enabled','NO'],
['Public agent calling share page','Valid link only','Valid link only','Valid link only'],
['Access another company without authorization','NO','NO','NO'],
];
const p=wb.worksheets.add('Role Permissions');p.showGridLines=false;
p.getRange('A2').values=[['4. User roles and permissions']];
p.getRange('A3').values=[['Use actual platform roles instead of Admin / Manager / Employee. Verify restrictions against the deployed build.']];
p.getRange('A5:E5').values=[['Feature','Super Admin','Company Developer','Company User','Test result / notes']];
p.getRange(`A6:E${perms.length+5}`).values=perms.map(x=>[...x,'']);
for(const [s,last,cols,widths] of [[sh,sections.length+5,'D',[29,38,100,40]],[p,perms.length+5,'E',[48,39,39,48,35]]]){
 s.getRange(`A5:${cols}${last}`).format={font:{name:'Arial',size:11,color:'#202320'},wrapText:true,verticalAlignment:'top',rowHeight:82};
 s.getRange(`A5:${cols}5`).format={fill:'#202320',font:{name:'Arial',size:11,bold:true,color:'#FFFFFF'},wrapText:true,horizontalAlignment:'center',verticalAlignment:'center',rowHeight:32};
 s.getRange('A2').format.font={name:'Arial',size:16,bold:true,color:'#202320'};
 widths.forEach((w,i)=>s.getRange(`${String.fromCharCode(65+i)}5:${String.fromCharCode(65+i)}${last}`).format.columnWidth=w);
 s.getRange(`${cols}6:${cols}${last}`).format.fill='#FFF8E5';
 s.freezePanes.freezeRows(5);
}
sh.getRange('C3').values=[['']];
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'Handover!A5:C9',tableMaxRows:5,tableMaxCols:3,maxChars:900})).ndjson);
console.log((await wb.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!',options:{useRegex:true,maxResults:5},maxChars:300})).ndjson);
for(const [sheet,range,file] of [['Handover','A5:D9','handover-preview.png'],['Role Permissions','A5:E9','roles-preview.png']]){
 const img=await wb.render({sheetName:sheet,range,scale:1,format:'png'});
 await fs.writeFile(path.join(dir,file),new Uint8Array(await img.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(wb)).save(path.join(dir,'Zea_Voice_Phase1_Testing_Handover.xlsx'));
console.log('Exported handover: all six requested sections and actual-role permissions.');
