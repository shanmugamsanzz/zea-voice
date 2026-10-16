import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import {Workbook,SpreadsheetFile} from '@oai/artifact-tool';
const raw=JSON.parse((await fs.readFile(new URL('./source.json',import.meta.url),'utf8')).replace(/^\uFEFF/,'')).map(r=>Array.isArray(r)?r:r.value);
const wb=Workbook.create();
const plots=[],buildings=[],review=[];
const clean=v=>String(v??'').trim().replace(/\s+/g,' ');
const num=v=>/^\d+(\.\d+)?$/.test(clean(v))?Number(v):null;
const issue=(id,row,field,text)=>review.push([id,row,field,text,'Needs owner confirmation']);
for(let index=1;index<raw.length;index++){
 const r=raw[index].map(clean), [id,name,place,count,plotnos,area,buildingArea,size,rate,facing,near,approval,road]=r;
 const sourceRow=index+1;
 if(id==='NRBU16'){issue(id,sourceRow,'Entire record','Only Project ID supplied; excluded from live inventory.');continue;}
 if(id==='NRBU17'){issue(id,sourceRow,'Section header','Embedded Building header excluded from live inventory; identifier preserved here.');continue;}
 if(!name)continue;
 if(name==='Building'){
  buildings.push([id,name,place,num(plotnos),num(area),num(buildingArea),rate==='95 Lakhs'?9500000:num(rate),'Total price; per house or listing unconfirmed','Currency not specified',facing,near,approval==='--'?'':approval,road,sourceRow,rate,'Confirm price currency and whether total is per house or whole listing']);
  issue(id,sourceRow,'Price basis and quantity','95 Lakhs preserved as 9,500,000; confirm currency and whether per house or listing total. '+(plotnos?'Source lists '+plotnos+' houses.':''));continue;
 }
 let numbers=[];
 if(id==='NRBU1')numbers=[9,10,11];
 else if(id==='NRBU2')numbers=[1,2,3,4,5,6,7,11,12,13,17];
 else if(id==='NRBU3')numbers=Array.from({length:10},(_,i)=>i+1);
 else if(id==='NRBU15')numbers=[20,21,14,15,16,18,19];
 else numbers=[null];
 const areaMap={};for(const m of area.matchAll(/(\d+)\s*,?\s*\(\s*(\d+)\s*\)/g))areaMap[Number(m[1])]=Number(m[2]);
 if(!rate)issue(id,sourceRow,'Rate','No rate supplied; agent must seek staff confirmation.');
 if(id==='NRBU2')issue(id,sourceRow,'Rate','Source says plots 1, 2, 17 Road Point 3000sq.ft and others 2500. Unit is ambiguous; normalized rate left blank.');
 if(approval)issue(id,sourceRow,'Approval',approval==='--'?'Approval not supplied.':'Approval label preserved exactly as '+approval+'; verify authority/name before making approval claims.');
 if(!count)issue(id,sourceRow,'Available count','No total count supplied. Listing or listed plot number is not proof of current availability.');
 if(id==='NRBU3')issue(id,sourceRow,'Individual plot areas','Only range 1391 to 2449 supplied; exact area for plots 1 to 10 is unknown.');
 if(id==='NRBU15')issue(id,sourceRow,'Individual plot areas','Seven plot numbers listed but no area supplied.');
 for(const no of numbers){
  const a=no===null?num(area):(areaMap[no]??null);
  let f=facing;
  if(id==='NRBU2')f=({1:'West',2:'West',17:'North west',3:'South',4:'South',5:'South',6:'Eastern south corner (source wording)',7:'East',11:'North',12:'North',13:'North'})[no];
  if(id==='NRBU15')f=[20,21].includes(no)?'South':no===14?'East':'West';
  const notes=[];
  if(!a)notes.push('Exact plot area not supplied');
  if(id==='NRBU3')notes.push('Project area range 1391 to 2449 sq.ft');
  if(id==='NRBU2')notes.push('Rate unit needs confirmation; see source rate text');
  const m=size.match(/^(\d+)\s*x\s*(\d+)$/i);
  if(m&&a&&Number(m[1])*Number(m[2])!==a){notes.push('Dimensions and area do not agree; do not calculate total');if(no===null)issue(id,sourceRow,'Area versus dimensions',`Stated area ${a} sq.ft; dimensions ${size} multiply to ${Number(m[1])*Number(m[2])}. Verify measurement units and area.`);}
  plots.push([id,name,place,no,a,id==='NRBU2'?null:num(rate),id==='NRBU2'?'Unit unconfirmed':'Per sq.ft (source column)','Currency not specified',f,near,approval==='--'?'':approval,road,num(count),count?'Listed as available in source; recheck freshness':'Availability not confirmed',no===null?size:'See source area text',notes.join('; '),sourceRow,rate,area,size]);
 }
}
const data=[
 ['Plots',['Project ID','Project name','Place','Plot number','Area sq.ft','Rate amount','Rate basis','Currency','Facing','Nearby locations','Approval as supplied','Road size','Source project available count','Availability status','Dimensions as supplied','Review notes','Source Excel row','Source rate text','Source area text','Source plot size text'],plots],
 ['Buildings',['Project ID','Property type','Place','Number of houses','Land area sq.ft','Building area sq.ft','Price amount','Price basis','Currency','Facing','Nearby locations','Approval as supplied','Road size','Source Excel row','Source price text','Review notes'],buildings],
 ['Review',['Project ID','Source Excel row','Field','Required clarification','Status'],review],
 ['Source Original',raw[0],raw.slice(1)]
];
for(const [name,headers,rows] of data){
 const sh=wb.worksheets.add(name),matrix=[headers,...rows];
 sh.getRangeByIndexes(0,0,matrix.length,headers.length).values=matrix;
 const range=sh.getRangeByIndexes(0,0,matrix.length,headers.length);
 range.format.font.name='Arial';range.format.font.size=10;range.format.rowHeight=32;range.format.columnWidth=23;range.format.verticalAlignment='center';
 const head=sh.getRangeByIndexes(0,0,1,headers.length);head.format.fill='#173B55';head.format.font.color='#FFFFFF';head.format.font.bold=true;head.format.wrapText=true;head.format.rowHeight=44;
 for(let i=2;i<matrix.length;i+=2)sh.getRangeByIndexes(i,0,1,headers.length).format.fill='#EEF3F7';
 sh.freezePanes.freezeRows(1);sh.freezePanes.freezeColumns(2);
 sh.getRangeByIndexes(1,0,rows.length,headers.length).format.wrapText=true;
 if(name==='Review'){sh.getRange('D1:D'+matrix.length).format.columnWidth=95;range.format.rowHeight=46;head.format.rowHeight=44;}
 if(name==='Plots'){sh.getRange('P1:P'+matrix.length).format.columnWidth=65;sh.getRange('R1:T'+matrix.length).format.columnWidth=55;sh.getRange('N1:N'+matrix.length).format.columnWidth=48;}
 if(name==='Source Original'){range.format.rowHeight=90;sh.getRange('F1:F'+matrix.length).format.columnWidth=65;sh.getRange('I1:K'+matrix.length).format.columnWidth=65;head.format.rowHeight=44;}
}
await fs.writeFile(new URL('./qa-summary.json',import.meta.url),JSON.stringify({plotRows:plots.length,buildingRows:buildings.length,reviewItems:review.length,notes:'Source dates unknown; availability not independently verified'},null,2));
await wb.recalculate();
await (await SpreadsheetFile.exportXlsx(wb)).save(fileURLToPath(new URL('./New Royal Builder Cleaned.xlsx',import.meta.url)));
for(const sheet of ['Plots','Buildings','Review']){
 const img=await wb.render({sheetName:sheet,range:sheet==='Review'?'A1:E7':sheet==='Plots'?'A1:H9':'A1:I3',scale:1.3,format:'png'});
 await fs.writeFile(new URL(`./preview-${sheet}.png`,import.meta.url),new Uint8Array(await img.arrayBuffer()));
}
console.log(JSON.stringify({plotRows:plots.length,buildings:buildings.length,reviewItems:review.length}));
