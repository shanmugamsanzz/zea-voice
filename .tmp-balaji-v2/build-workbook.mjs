import fs from 'node:fs/promises';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const wb=Workbook.create();
const p=wb.worksheets.add('Live Prices');
p.getRange('A1:G3').values=[['service_id','service_name','price_inr','currency','quote_allowed','conditions','source'],['GENERAL-CONSULTATION','General Consultation',350,'INR',true,'Consultation only; not treatment cost or confirmed slot.','Client-approved consultation fee'],['TELE-CONSULTATION','Teleconsultation',350,'INR',true,'Paid consultation; not treatment cost or confirmed slot.','User-approved correction: Teleconsultation fee INR 350']];
p.getRange('A1:G3').format.wrapText=true;
p.getRange('A1:G1').format.fill='#17324D';p.getRange('A1:G1').format.font={bold:true,color:'#FFFFFF'};
for(const [col,width] of [['A',27],['B',24],['C',14],['D',12],['E',17],['F',48],['G',49]])p.getRange(`${col}:${col}`).format.columnWidth=width;
p.getRange('1:1').format.rowHeight=32;p.getRange('2:3').format.rowHeight=65;p.getRange('C2:C3').setNumberFormat('0.00');
const s=wb.worksheets.add('Instructions');
const rows=[['Balaji Live Data setup v2','Reviewed 24 October 2026'],['Fee source','Existing client facts and user-approved correction: both consultation types INR 350.'],['Quote rule','Quote only matching numeric price_inr with quote_allowed TRUE. Missing/disabled Live Data: consult current approved KB; otherwise staff confirmation.'],['Scope','General Consultation and Teleconsultation only. No treatment, therapy, room, procedure or package prices.'],['Availability','Prices are not appointment slots, staff presence, booking confirmation or payment verification.'],['Field types','price_inr: number; quote_allowed: boolean; other columns: text.'],['Upload','Upload Live Prices only; Instructions is setup guidance, not price records.'],['Refresh','Replace/update both deployed agents Live Data after edits. This workbook does not automatically synchronize.']];
s.getRange('A1:B8').values=rows;s.getRange('A1:B8').format.wrapText=true;s.getRange('A:A').format.columnWidth=25;s.getRange('B:B').format.columnWidth=100;s.getRange('1:8').format.rowHeight=48;s.getRange('A1:B1').format.fill='#17324D';s.getRange('A1:B1').format.font={bold:true,color:'#FFFFFF'};
wb.recalculate();
console.log(JSON.stringify(p.getRange('A1:G3').values));
await fs.mkdir('outputs/balaji-v2',{recursive:true});
for(const [sheet,range,file] of [['Live Prices','A1:G3','prices.png'],['Instructions','A1:B8','instructions.png']]){
 const b=await wb.render({sheetName:sheet,range,scale:1.4});await fs.writeFile(`.tmp-balaji-v2/${file}`,new Uint8Array(await b.arrayBuffer()));
}
const out=await SpreadsheetFile.exportXlsx(wb);await out.save('docs/prompts/balaji robatic/v2/LIVE_PRICES.xlsx');await out.save('outputs/balaji-v2/LIVE_PRICES.xlsx');
