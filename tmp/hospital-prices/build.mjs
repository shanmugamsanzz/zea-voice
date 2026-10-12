import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {Workbook, SpreadsheetFile} from '@oai/artifact-tool';
const raw = [
['MHC-SILVER','Silver','Master Health',1650,2,''],
['MHC-GOLD','Gold','Master Health',4950,2,''],
['MHC-PLATINUM','Platinum','Master Health',7980,2,'Any four consultations from documented list.'],
['DIABETIC','Diabetic Health Check-up','Specialized',3200,3,'Also called Sugar Health Checkup.'],
['RENAL','Renal Health Check-up','Organ',1400,5,'Consultation details in voice-agent brief.'],
['LIVER','Liver Health Check-up','Organ',1400,5,'Consultation details in voice-agent brief.'],
['CARDIAC','Cardiac Health Check-up','Organ',2950,5,'Separate TMT billing requires clarification.'],
['LUNGS','Lungs Health Check-up','Organ',999,5,''],
['ORTHO','Ortho Health Check-up','Organ',1499,5,'Two X-rays as per requirement.'],
['GASTRO','Gastro Health Check-up','Organ',25000,5,'Document states one-day admission.'],
['SURGERY-1','Surgery Profile 1','Surgery Profile',1500,5,''],
['SURGERY-2','Surgery Profile 2 - Minor Procedures','Surgery Profile',750,5,''],
['ONCO-PREMIUM-M','Onco Care Screening Premium - Male','Oncology',8600,4,''],
['ONCO-PREMIUM-F','Onco Care Screening Premium - Female','Oncology',8800,4,''],
['ONCO-ADDON-M','Onco Care Screening Add-on - Male','Oncology',750,4,'Confirm applicable base package with staff.'],
['ONCO-ADDON-F','Onco Care Screening Add-on - Female','Oncology',1100,4,'Confirm applicable base package with staff.'],
['PAEDIATRIC','Paediatric Health Screening','Child Screening',1500,3,''],
['DEV-PRETERM','Developmental Screening - Preterm / Delay','Child Screening',450,3,'Preterm children or developmental delay.'],
['IQ-5-13','IQ Assessment - Ages 5 to 13','Child Screening',1500,3,'Age 5 to 13 as printed.'],
['IQ-OVER-13','IQ Assessment - Above Age 13','Child Screening',2000,3,'Above age 13 as printed.'],
['BEHAVIOURAL','Behavioural Assessment','Child Screening',500,3,''],
['DEV-DISORDER','Developmental Disorder Screening','Child Screening',500,3,''],
['NEONATAL-3','Neonatal Screening - Three Panel','Newborn',800,3,'TSH, 17-OHP, G6PD.'],
['NEONATAL-4','Neonatal Screening - Four Panel','Newborn',1000,3,'TSH, 17-OHP, G6PD, Galactose (source wording).'],
['NEWBORN-HEARING','Newborn Hearing Screening','Newborn',1200,3,''],
['TMT','TMT','Additional Test',null,2,'Printed as 850 + 336. Confirm charge meaning before quoting.'],
['AUDIOGRAM','Audiogram','Additional Test',300,2,'Confirm package eligibility / additional charge with staff.'],
['PFT','PFT - Separate Test','Additional Test',350,2,'Confirm package eligibility / additional charge with staff.'],
];
const rows=raw.map(([id,name,category,price,page,notes])=>[id,name,category,price,'INR',price!==null,notes,`Hospital brochure p${page}`]);
assert.equal(rows.length,28); assert.equal(new Set(rows.map(r=>r[0])).size,28);
assert.equal(rows.filter(r=>r[5]).length,27);
const wb=Workbook.create(); const sheet=wb.worksheets.add('Live Prices');
sheet.showGridLines=false;
const headers=['package_id','package_name','category','price_inr','currency','quote_allowed','conditions','source'];
sheet.getRange('A1:H29').values=[headers,...rows];
sheet.getRange('A1:H29').format.font.name='Arial';
sheet.getRange('A1:H29').format.font.size=10;
sheet.getRange('A1:H29').format.verticalAlignment='center';
sheet.getRange('A1:H1').format.fill='#155E63';
sheet.getRange('A1:H1').format.font.color='#FFFFFF';
sheet.getRange('A1:H1').format.font.bold=true;
sheet.getRange('A1:H1').format.rowHeight=28;
sheet.getRange('A2:H29').format.rowHeight=40;
sheet.getRange('B2:C29').format.wrapText=true;
sheet.getRange('G2:H29').format.wrapText=true;
for(const [col,width] of [['A',24],['B',42],['C',22],['D',14],['E',11],['F',18],['G',58],['H',28]])sheet.getRange(`${col}1:${col}29`).format.columnWidth=width;
sheet.getRange('D2:D29').setNumberFormat('#,##0');
for(let row=2;row<=29;row++)if(row%2===0)sheet.getRange(`A${row}:H${row}`).format.fill='#F0F7F6';
sheet.getRange('A27:H27').format.fill='#FFF0CC';
sheet.freezePanes.freezeRows(1);
sheet.freezePanes.freezeColumns(2);
const notes=wb.worksheets.add('Usage and Sources'); notes.showGridLines=false;
notes.getRange('A1:B10').values=[
['Shanmuga Hospital live price table',''],
['Rows','28 services; 27 numeric prices; TMT held for confirmation.'],
['Price source','Shanmuga_Master_Health_Check-up_Packages.pdf, pages 2-5.'],
['Supporting source','KNOWLEDGE BASE FOR VOICE AGENT.pdf, pages 1-4.'],
['Client approval','Client-provided document prices approved for this workbook on 2026-10-10.'],
['Agent quoting rule','Quote only a numeric price when quote_allowed is TRUE. FALSE / blank price means staff confirmation.'],
['Live Data setup','Use Live Prices headers as columns. price_inr: number; quote_allowed: boolean; other columns: text.'],
['Scope','quote_allowed is price permission, not real appointment availability. Use slot-checking tool for slots.'],
['Unknown conditions','Offer validity, taxes and price effective dates are not provided. No extra discounts assumed.'],
['Updating','Edit numeric prices and conditions, then update both agents Live Data. This file does not synchronize automatically.'],
];
notes.getRange('A1:B10').format.font.name='Arial'; notes.getRange('A1:B10').format.font.size=11;
notes.getRange('A1:B1').format.font.bold=true;
notes.getRange('A1:A10').format.columnWidth=28;notes.getRange('B1:B10').format.columnWidth=100;
notes.getRange('A1:B10').format.wrapText=true;notes.getRange('A1:B10').format.rowHeight=40;
wb.recalculate();
console.log((await wb.inspect({kind:'table',range:'Live Prices!A1:F4',include:'values',tableMaxRows:4,tableMaxCols:6,maxChars:1600})).ndjson);
const out='D:/SHANMUGAM-PROJECTS/zea-voice/docs/prompts/shannmuga hospital/LIVE_PRICES.xlsx';
await (await SpreadsheetFile.exportXlsx(wb)).save(out);
for(const [name,range,file] of [['Live Prices','A1:H15','prices-top.png'],['Live Prices','A16:H29','prices-bottom.png'],['Usage and Sources','A1:B10','usage.png']]){
 const preview=await wb.render({sheetName:name,range,scale:1,format:'png'});
 await fs.writeFile(new URL(file,import.meta.url),new Uint8Array(await preview.arrayBuffer()));
}
console.log('Saved '+out);
