import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const wb=Workbook.create();
const s=wb.worksheets.add('Live Prices');s.showGridLines=false;
const rows=[
['service_id','service_name','price_inr','currency','quote_allowed','conditions','source'],
['GENERAL-CONSULTATION','General Consultation',350,'INR',true,'Consultation only; not total treatment cost or confirmed teleconsult tariff.','Completed client checklist: consultation fee'],
['TELE-CONSULTATION','Teleconsultation',null,'INR',false,'Fee not separately approved. Seek staff confirmation; do not copy general fee.','Client checklist: teleconsult schedule; no separate fee'],
];
s.getRange('A1:G3').values=rows;
s.getRange('A1:G3').format.font.name='Arial';s.getRange('A1:G3').format.font.size=10;
s.getRange('A1:G3').format.verticalAlignment='center';
s.getRange('A1:G1').format.fill='#155E63';s.getRange('A1:G1').format.font.color='#FFFFFF';s.getRange('A1:G1').format.font.bold=true;
s.getRange('A1:G1').format.rowHeight=30;s.getRange('A2:G3').format.rowHeight=65;
s.getRange('A2:G3').format.wrapText=true;s.getRange('A3:G3').format.fill='#FFF0CC';
for(const [c,w] of [['A',27],['B',28],['C',14],['D',11],['E',18],['F',60],['G',48]])s.getRange(`${c}1:${c}3`).format.columnWidth=w;
s.getRange('C2:C3').setNumberFormat('#,##0');
const notes=wb.worksheets.add('Usage');notes.showGridLines=false;
notes.getRange('A1:B7').values=[
['Balaji Live Data setup',''],
['Numeric fee source','Completed client checklist supplied by the user; reviewed 2026-10-10.'],
['Quote rule','Quote only numeric price_inr with quote_allowed TRUE. Blank / FALSE requires staff confirmation.'],
['Scope','General consultation only. No approved therapy, room, treatment, procedure, prosthetic or package prices.'],
['Availability','Use approved schedules and live calendar tools. This sheet is not slot availability.'],
['Upload','Use Live Prices headers as fields: number for price_inr, boolean for quote_allowed; other columns text.'],
['Refresh','Update both agents Live Data after price edits. This workbook does not automatically synchronize.'],
];
notes.getRange('A1:B7').format.font.name='Arial';notes.getRange('A1:B7').format.font.size=11;
notes.getRange('A1:B1').format.font.bold=true;notes.getRange('A1:A7').format.columnWidth=26;notes.getRange('B1:B7').format.columnWidth=100;
notes.getRange('A1:B7').format.wrapText=true;notes.getRange('A1:B7').format.rowHeight=43;
wb.recalculate();assert.equal(rows[1][2],350);assert.equal(rows[2][2],null);
await (await SpreadsheetFile.exportXlsx(wb)).save('D:/SHANMUGAM-PROJECTS/zea-voice/docs/prompts/balaji robatic/LIVE_PRICES.xlsx');
for(const [sheet,range,file] of [['Live Prices','A1:G3','balaji-prices.png'],['Usage','A1:B7','balaji-usage.png']]){
 const blob=await wb.render({sheetName:sheet,range,scale:1,format:'png'});
 await fs.writeFile(new URL(file,import.meta.url),new Uint8Array(await blob.arrayBuffer()));
}
console.log('Exported and rendered Balaji LIVE_PRICES.xlsx');
