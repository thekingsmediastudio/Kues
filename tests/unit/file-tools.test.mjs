import test from 'node:test';import assert from 'node:assert/strict';
import {zipSync,strToU8,unzipSync,strFromU8}from'fflate';
import {parseDocument,exportReport,parseCsv,FILE_BYTES}from'../../apps/web/lib/ai-agent/file-formats.mjs';
import {createFileTools,parseInWorker}from'../../apps/web/lib/ai-agent/file-tools.mjs';
const agent={id:'agent-a',settings:{toolPermissions:{read_files:true,create_files:true}}};
const scope={userId:'user-a',workspaceId:'workspace-a',agent};
const report='# Budget\n\n| Category | USD |\n| --- | --- |\n| Office | 120 |\n| Software | 230 |\n| Travel | 100 |';
test('text and CSV parsing are bounded and retain row labels',async()=>{
 const csv=await parseDocument(Buffer.from('Name,Value\n"Line\none",42\n'),'data.csv');assert.match(csv.text,/Line\\none/);assert.match(csv.text,/42/);
 assert.throws(()=>parseCsv('"unclosed'),/file_csv_invalid/);
 const long=await parseDocument(Buffer.from('x'.repeat(10000)),'long.txt');assert.equal(long.text.length,10000);assert.equal(long.truncated,false);assert(long.sections.length>1);
 await assert.rejects(parseDocument(Buffer.alloc(FILE_BYTES+1),'large.txt'),/file_size_invalid/);await assert.rejects(parseDocument(Buffer.from('a'),'legacy.xls'),/file_type_unsupported/);
});
test('Word and spreadsheet reports are OOXML and round-trip through extraction',async()=>{
 for(const format of ['docx','xlsx']){const output=exportReport(report,format);assert.equal(output.bytes.subarray(0,2).toString(),'PK');const parsed=await parseDocument(output.bytes,'budget.'+format);assert.match(parsed.text,/Software/);assert.match(parsed.text,/230/)}
 const sheet=strFromU8(unzipSync(exportReport(report,'xlsx').bytes)['xl/worksheets/sheet1.xml']);assert.match(sheet,/<v>230<\/v>/);assert.doesNotMatch(sheet,/<f>/);
});
test('exported spreadsheets prevent formulas and CSV injection while preserving numbers',()=>{
 const text='| Name | Value |\n| --- | --- |\n| Safe | -120 |\n| Risk | =HYPERLINK("https://bad.example") |';
 const csv=exportReport(text,'csv').bytes.toString();assert.match(csv,/"-120"/);assert.match(csv,/"'=HYPERLINK/);
 const sheet=strFromU8(unzipSync(exportReport(text,'xlsx').bytes)['xl/worksheets/sheet1.xml']);assert.doesNotMatch(sheet,/<f>/);assert.match(sheet,/t="inlineStr"/);assert.match(sheet,/<v>-120<\/v>/);
});
test('archive entity declarations and traversal are rejected',async()=>{
 const unsafe=zipSync({'word/document.xml':strToU8('<!DOCTYPE doc [<!ENTITY x "secret">]><document>&x;</document>')});await assert.rejects(parseDocument(unsafe,'unsafe.docx'),/file_xml_unsafe/);
 const traversal=zipSync({'../word/document.xml':strToU8('<p>text</p>')});await assert.rejects(parseDocument(traversal,'unsafe.docx'),/file_archive_unsafe/);
 const bomb=zipSync({'word/document.xml':strToU8('x'.repeat(5*1024*1024))},{level:9});await assert.rejects(parseDocument(bomb,'big.docx'),/file_archive_limit/);
});
test('temporary file text is scoped to user, workspace and agent, and expires',async()=>{
 let time=0;const service=createFileTools({now:()=>time,parse:parseDocument});const result=await service.add({...scope,bytes:Buffer.from('Example document content'),name:'note.txt'});
 assert(!Object.hasOwn(result,'text'));assert.equal(service.context({...scope,ids:[result.id]}).files[0].text,'Example document content');
 for(const other of [{...scope,userId:'other'},{...scope,workspaceId:'other'},{...scope,agent:{...agent,id:'other'}}])assert.throws(()=>service.context({...other,ids:[result.id]}),e=>e.code==='file_unavailable');
 assert.throws(()=>service.context({...scope,agent:{...agent,settings:{}},ids:[result.id]}),e=>e.code==='file_permission_required');
 time=15*60000;assert.throws(()=>service.context({...scope,ids:[result.id]}),e=>e.code==='file_unavailable');
});
test('workers extract text and pre-cancel without leaving a pending worker',async()=>{
 assert.equal((await parseInWorker(Buffer.from('Actual worker text'),'note.txt')).text,'Actual worker text');
 const controller=new AbortController();controller.abort();await assert.rejects(parseInWorker(Buffer.from('text'),'note.txt',controller.signal),e=>e.code==='file_canceled');
});
test('exports require separate permission and never run formulas',()=>{
 const service=createFileTools();assert.throws(()=>service.export({agent:{settings:{toolPermissions:{read_files:true}}},text:'Report',format:'docx'}),e=>e.code==='file_permission_required');
 assert.throws(()=>exportReport('Report','html'),/export_format_invalid/);assert.throws(()=>exportReport('x'.repeat(50001),'docx'),/export_text_invalid/);
});
