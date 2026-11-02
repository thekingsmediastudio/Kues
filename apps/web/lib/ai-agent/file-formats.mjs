import { Unzip, UnzipInflate, zipSync, strToU8 } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
export const FILE_BYTES = 2 * 1024 * 1024;
export const FILE_TEXT = 8000;
export const FILE_EXTENSIONS = ['txt','md','csv','pdf','docx','xlsx'];
export function fileExtension(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\u0000-\u001f\u007f/\\]/.test(name)) throw new Error('file_name_invalid');
  const ext = name.toLowerCase().split('.').at(-1);
  if (!FILE_EXTENSIONS.includes(ext)) throw new Error('file_type_unsupported');
  return ext;
}
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const content = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(content).join('') : value && typeof value === 'object' ? Object.entries(value).filter(([k]) => !k.startsWith('@_')).map(([,v]) => content(v)).join('') : '';
function xml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('file_xml_unsafe');
  return new XMLParser({ ignoreAttributes:false, removeNSPrefix:true, parseTagValue:false, parseAttributeValue:false, trimValues:false }).parse(source);
}
function unzipXml(bytes) {
  const files = {}; let count=0,total=0;
  const unzip = new Unzip(file => {
    if (++count > 200) throw new Error('file_archive_limit');
    if (file.name.includes('..') || file.name.startsWith('/') || file.name.includes('\\')) throw new Error('file_archive_unsafe');
    if (!/^(word\/document\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet[0-9]+\.xml)$/.test(file.name)) return;
    const chunks=[];let size=0;
    file.ondata=(error,chunk,final)=>{
      if(error)throw /^file_/.test(error.message)?error:new Error('file_archive_invalid');size+=chunk.length;total+=chunk.length;
      if(size>4*1024*1024||total>8*1024*1024)throw new Error('file_archive_limit');
      chunks.push(chunk);
      if(final){const all=new Uint8Array(size);let offset=0;for(const part of chunks){all.set(part,offset);offset+=part.length}files[file.name]=new TextDecoder('utf-8',{fatal:true}).decode(all)}
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for(let i=0;i<bytes.length;i+=1024)unzip.push(bytes.subarray(i,i+1024),i+1024>=bytes.length);
  return files;
}
export function parseCsv(source, maxRows=500, maxCols=50) {
  const rows=[];let row=[],cell='',quoted=false,truncated=false;
  const addCell=()=>{if(row.length<maxCols)row.push(cell);else truncated=true;cell=''};
  const addRow=()=>{addCell();if(rows.length<maxRows)rows.push(row);else truncated=true;row=[]};
  for(let i=0;i<source.length;i++){
    const c=source[i];
    if(c==='"'){if(quoted&&source[i+1]==='"'){cell+='"';i++}else if(quoted||!cell)quoted=!quoted;else cell+=c}
    else if(c===','&&!quoted)addCell();
    else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&source[i+1]==='\n')i++;addRow()}
    else cell+=c;
    if(rows.length>=maxRows&&i<source.length-1){truncated=true;break}
  }
  if(quoted&&!truncated)throw new Error('file_csv_invalid');
  if(cell||row.length)addRow();
  return {rows,truncated};
}
export async function parseDocument(bytes, name) {
  const ext=fileExtension(name);if(!bytes.length||bytes.length>FILE_BYTES)throw new Error('file_size_invalid');
  let text='',notes=[];
  if(['txt','md','csv'].includes(ext)){
    text=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');
    if(/\u0000/.test(text))throw new Error('file_binary_unsupported');
    if(ext==='csv'){const parsed=parseCsv(text);text=parsed.rows.map((row,i)=>`Row ${i+1}: `+JSON.stringify(row)).join('\n');if(parsed.truncated)notes.push('CSV limited to 500 rows and 50 columns.');}
  } else if(ext==='pdf'){
    if(new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw new Error('file_pdf_invalid');
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task=getDocument({data:bytes,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,disableAutoFetch:true,stopAtErrors:true,verbosity:0});
    try{const doc=await task.promise;const cap=Math.min(doc.numPages,20);let read=0;
      for(let i=1;i<=cap&&text.length<FILE_TEXT;i++){const page=await doc.getPage(i);const tc=await page.getTextContent();text+=`\n[Page ${i}]\n`+tc.items.map(item=>typeof item.str==='string'?item.str+(item.hasEOL?'\n':' '):'').join('');read++;page.cleanup();}
      notes.push(`Text extracted from ${read} of ${doc.numPages} pages. Images, scans and visual layout are not read.`);
      if(!text.replace(/\[Page \d+\]/g,'').trim())throw new Error('file_pdf_no_text');
    }catch(error){if(error.message==='file_pdf_no_text')throw error;throw new Error('file_pdf_unreadable')}finally{await task.destroy();}
  }else{
    if(bytes[0]!==80||bytes[1]!==75)throw new Error('file_archive_invalid');const files=unzipXml(bytes);
    if(ext==='docx'){
      const body=files['word/document.xml'];if(!body)throw new Error('file_docx_invalid');xml(body);
      const parser=new XMLParser({ignoreAttributes:true,removeNSPrefix:true,preserveOrder:true,parseTagValue:false,trimValues:false});
      const walk=node=>{if(Array.isArray(node))return node.map(walk).join('');if(!node||typeof node!=='object')return String(node||'');return Object.entries(node).map(([k,v])=>['instrText','del',':@'].includes(k)?'':k==='tab'?'\t':k==='br'?'\n':walk(v)+(k==='p'?'\n':'')).join('')};
      text=walk(parser.parse(body));notes.push('Main document text only; images, comments, headers and footers are not read.');
    }else{
      const shared=files['xl/sharedStrings.xml']?array(xml(files['xl/sharedStrings.xml']).sst?.si).map(content):[];
      const sheets=Object.keys(files).filter(k=>k.startsWith('xl/worksheets/')).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
      if(!sheets.length)throw new Error('file_xlsx_invalid');let formulas=false;
      for(const path of sheets.slice(0,3)){
        const sheet=xml(files[path]);const rows=array(sheet.worksheet?.sheetData?.row);text+=`\n[${path.split('/').at(-1)}]\n`;
        for(const row of rows.slice(0,300)){
          const cells=[];for(const c of array(row.c).slice(0,50)){
            const type=c['@_t'];let value=type==='s'?(shared[Number(c.v)]??''):type==='inlineStr'?content(c.is):content(c.v);
            if(c.f!==undefined){formulas=true;if(!value)value='[formula without stored value]'}
            cells.push(`${c['@_r']||'cell'}: ${value}`);
          }text+=cells.join(' | ')+'\n';if(text.length>FILE_TEXT)break;
        }if(text.length>FILE_TEXT)break;
      }
      notes.push(`Read up to 3 worksheets (${sheets.length} found), 300 rows and 50 cells per row. Dates may be numeric serial values. Charts and formatting are not read.`);
      if(formulas)notes.push('Formula cells use stored values only; formulas were not calculated.');
    }
  }
  text=text.replace(/\u0000/g,'').trim();if(!text)throw new Error('file_empty');
  const truncated=text.length>FILE_TEXT;if(truncated)notes.push(`Text limited to the first ${FILE_TEXT.toLocaleString('en-US')} characters; remaining content was not supplied.`);
  return {text:text.slice(0,FILE_TEXT),notes,truncated,format:ext};
}
const escapeXml=value=>String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
export function reportRows(text) {
  const lines=text.split(/\r?\n/);const split=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(v=>v.trim().replace(/\\\|/g,'|').replace(/\*\*([^*]+)\*\*/g,'$1').replace(/`([^`]+)`/g,'$1'));
  for(let i=0;i<lines.length-1;i++){const cells=split(lines[i+1]);if(lines[i].includes('|')&&cells.length>1&&cells.every(v=>/^:?-{3,}:?$/.test(v))){const rows=[split(lines[i]).slice(0,50)];for(let j=i+2;j<lines.length&&lines[j].includes('|')&&rows.length<500;j++)rows.push(split(lines[j]).slice(0,50));return rows}}
  return [['Text'],...lines.filter(Boolean).slice(0,499).map(line=>[line])];
}
const numeric=value=>/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)&&value.replace(/[-.]/g,'').length<=15&&Number.isFinite(Number(value));
export function exportReport(text, format) {
  if(typeof text!=='string'||!text.trim()||text.length>50000)throw new Error('export_text_invalid');
  if(!['md','txt','csv','docx','xlsx'].includes(format))throw new Error('export_format_invalid');
  if(format==='md'||format==='txt')return {bytes:Buffer.from(text),mime:format==='md'?'text/markdown; charset=utf-8':'text/plain; charset=utf-8'};
  if(format==='csv')return {bytes:Buffer.from('\uFEFF'+reportRows(text).map(row=>row.map(value=>'"'+(!numeric(value)&&/^[\s]*[=+\-@]/.test(value)?"'"+value:value).replaceAll('"','""')+'"').join(',')).join('\r\n')),mime:'text/csv; charset=utf-8'};
  const types='<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>';
  const rel=(type,target)=>`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`;
  let files,mime;
  if(format==='docx'){
    const paragraphs=text.split(/\r?\n/).map(line=>{const heading=/^#{1,3}\s/.test(line);return `<w:p><w:r>${heading?'<w:rPr><w:b/><w:sz w:val="28"/></w:rPr>':''}<w:t xml:space="preserve">${escapeXml(line.replace(/^#{1,6}\s/,''))}</w:t></w:r></w:p>`}).join('');
    files={'[Content_Types].xml':types+'<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','_rels/.rels':rel('officeDocument','word/document.xml'),'word/document.xml':`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr/></w:body></w:document>`};mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }else{
    const column=i=>{let name='';for(i++;i;i=Math.floor((i-1)/26))name=String.fromCharCode(65+(i-1)%26)+name;return name};
    const rows=reportRows(text).map((row,r)=>`<row r="${r+1}">`+row.map((value,c)=>numeric(value)?`<c r="${column(c)}${r+1}" t="n"><v>${value}</v></c>`:`<c r="${column(c)}${r+1}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`).join('')+'</row>').join('');
    files={'[Content_Types].xml':types+'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>','_rels/.rels':rel('officeDocument','xl/workbook.xml'),'xl/_rels/workbook.xml.rels':rel('worksheet','worksheets/sheet1.xml'),'xl/workbook.xml':'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets></workbook>','xl/worksheets/sheet1.xml':`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`};mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return {bytes:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,strToU8(value)])),{level:6})),mime};
}
