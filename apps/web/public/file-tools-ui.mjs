const MAX_BYTES=2*1024*1024;
const supported=/\.(txt|md|csv|pdf|docx|xlsx)$/i;
export function fileErrorCopy(code){return ({
 file_permission_required:'Enable the relevant file permission in this agent’s Tools settings.',
 file_size_invalid:'Choose a non-empty file no larger than 2 MB.',file_type_unsupported:'Supported files: PDF, DOCX, TXT, Markdown, CSV and XLSX.',
 file_name_invalid:'Rename the file without slashes or control characters, then try again.',file_unavailable:'An attachment expired or is unavailable for this agent. Remove it and attach the file again.',
 file_pdf_no_text:'This PDF has no extractable text. Scanned PDFs need OCR, which is not supported yet.',file_pdf_unreadable:'This PDF could not be read. Encrypted, damaged or unsupported PDFs are not accepted.',
 file_rate_limited:'File processing is busy or the request limit was reached. Try again shortly.',file_storage_limit:'Remove an unused attachment or wait for temporary files to expire.',
 file_parse_timeout:'The file took too long to process. Try a smaller or simpler file.',file_parse_failed:'The file could not be safely read. Try a supported, unencrypted file.',
 file_archive_limit:'The document expands beyond the safe processing limit. Try a smaller file.',file_binary_unsupported:'This text file appears to contain binary data. Use UTF-8 text.',
 file_csv_invalid:'The CSV has an unfinished quoted field. Check the file and try again.',
 file_service_unavailable:'File processing is unavailable on this server.',file_consent_required:'Agree to send extracted file text before asking the agent to analyze it.',
 file_research_combination_unsupported:'Use file analysis and web research in separate messages for this first trial.',
 authentication_required:'Sign in again to use files.',file_admin_required:'File tools are not available for this account.',
 export_text_invalid:'This reply is empty or too large to export (maximum 50,000 characters).'
})[code]||'The file operation could not complete. Your draft is unchanged.'}
export function createFileToolsUI(adapter){
 const picker=document.getElementById('chatFilePicker'),host=document.getElementById('chatAttachments');
 let files=[],contextKey='',upload=null;
 const key=()=>{const c=adapter.context();return `${c.agentId}:${c.version}`};
 const removeRemote=(file,agentId)=>fetch(`/api/files/remove?agentId=${encodeURIComponent(agentId)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:file.id})}).catch(()=>{});
 function render(){
  host.replaceChildren();host.hidden=!files.length&&!upload;
  if(upload){const status=document.createElement('p');status.role='status';status.textContent='Extracting file text…';host.append(status)}
  for(const file of files){const row=document.createElement('div');row.className='file-attachment';const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent=file.name;const notes=document.createElement('p');notes.textContent=`${file.characters.toLocaleString()} characters extracted. `+(file.notes||[]).join(' ');details.append(summary,notes);const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.ariaLabel=`Remove ${file.name}`;remove.onclick=()=>{files=files.filter(item=>item.id!==file.id);void removeRemote(file,file.agentId);render()};row.append(details,remove);host.append(row)}
  if(files.length){const note=document.createElement('p');note.className='file-attachment-note';note.textContent='Temporary text expires after 15 minutes. It goes to the AI only when you send. Open a filename to review extraction limits.';host.append(note)}
 }
 function sync(){const next=key();if(next!==contextKey){upload?.abort();upload=null;const previous=files;files=[];contextKey=next;previous.forEach(file=>void removeRemote(file,file.agentId));render()}}
 document.getElementById('attachFilesButton').onclick=()=>{sync();const c=adapter.context();if(!c.canUse)return;adapter.closeMenu?.();if(!c.agent?.settings?.toolPermissions?.read_files){adapter.status(fileErrorCopy('file_permission_required'));return}picker.click()};
 picker.onchange=async()=>{
  sync();const selected=[...picker.files];picker.value='';const c=adapter.context();const startingKey=key();
  if(upload||!c.canUse)return;
  if(files.length+selected.length>3){adapter.status('Attach up to three files per message.');return}
  if(selected.some(file=>!supported.test(file.name))){adapter.status(fileErrorCopy('file_type_unsupported'));return}
  if(selected.some(file=>!file.size||file.size>MAX_BYTES)){adapter.status(fileErrorCopy('file_size_invalid'));return}
  const controller=new AbortController();upload=controller;render();
  try{
   for(const file of selected){
    if(controller.signal.aborted||startingKey!==key())break;
    const timer=setTimeout(()=>controller.abort(),35000);
    try{const response=await fetch(`/api/files/upload?agentId=${encodeURIComponent(c.agentId)}&name=${encodeURIComponent(file.name)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream'},body:file,signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(data.error);
      if(startingKey!==key()){void removeRemote(data,c.agentId);break}
      files.push({...data,agentId:c.agentId});render();
    }finally{clearTimeout(timer)}
   }
   if(startingKey===key())adapter.status('File text is ready. Ask your question, review the answer, then choose a download format if needed.');
  }catch(error){if(startingKey===key())adapter.status(controller.signal.aborted?'File upload canceled or timed out. Your draft is unchanged.':fileErrorCopy(error.message))}
  finally{if(upload===controller)upload=null;render()}
 };
 function prepareSend(message){
  sync();if(upload){adapter.status('Wait for file text extraction to finish before sending.');return false}
  if(!files.length)return [];
  if(files.some(file=>Date.parse(file.expiresAt)<=Date.now())){adapter.status(fileErrorCopy('file_unavailable'));return false}
  if(/^\/research(?:\s|$)/i.test(message)){adapter.status(fileErrorCopy('file_research_combination_unsupported'));return false}
  if(!window.confirm('Send the extracted text from these files to your selected AI provider? Only extracted text is sent here. Originals explicitly saved in Workspace files remain in cloud storage until deleted. Temporary extracted text expires after 15 minutes. Your question, filenames and the AI answer are saved in chat history. Continue?'))return false;
  return files.map(file=>file.id);
 }
 function addDownloads(answerNode,text,agentId){
  if(answerNode.querySelector('.reply-downloads'))return;
  const c=adapter.context();if(c.agentId!==String(agentId)||c.agent?.settings?.toolPermissions?.create_files!==true||!text.trim())return;
  const bar=document.createElement('div');bar.className='reply-downloads';const select=document.createElement('select');select.ariaLabel='Download format';
  for(const [value,label]of[['docx','Word report (.docx)'],['xlsx','Spreadsheet (.xlsx)'],['csv','CSV (.csv)'],['md','Markdown (.md)'],['txt','Plain text (.txt)']]){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option)}
  const button=document.createElement('button');button.type='button';button.textContent='Download';const status=document.createElement('span');status.role='status';
  button.onclick=async()=>{const format=select.value;button.disabled=true;status.textContent='Preparing…';try{const response=await fetch(`/api/files/export?agentId=${encodeURIComponent(agentId)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,text})});if(!response.ok){const data=await response.json();throw new Error(data.error)}const blob=await response.blob();const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`Keus-report.${format}`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);status.textContent='Download prepared.'}catch(error){status.textContent=fileErrorCopy(error.message)}finally{button.disabled=false}};
  const note=document.createElement('small');note.textContent='Exports this reply. Spreadsheets use the first table, or a single text column. Check important figures before use.';
  const save=document.createElement('button');save.type='button';save.textContent='Save to workspace';
  save.onclick=async()=>{if(!window.confirm('Save this reply as an original file in this agent’s Backblaze cloud storage until you delete it? Provider storage and transfer allowances apply. Continue?'))return;const format=select.value;save.disabled=true;status.textContent='Saving…';try{const report=await fetch(`/api/files/export?agentId=${encodeURIComponent(agentId)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({format,text})});if(!report.ok){const data=await report.json();throw new Error(data.error)}const blob=await report.blob();const response=await fetch(`/api/workspace-files/upload?agentId=${encodeURIComponent(agentId)}&path=${encodeURIComponent('outputs/Keus-report.'+format)}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/octet-stream','X-Workspace-Storage-Consent':'workspace-storage-v1'},body:blob});if(!response.ok){const data=await response.json();throw new Error(data.error)}status.textContent='Saved in Workspace files.'}catch(e){status.textContent=e.message==='library_not_configured'?'Cloud storage is not connected yet. Download still works.':fileErrorCopy(e.message)}finally{save.disabled=false}};
  bar.append(select,button,save,status,note);answerNode.append(bar);
 }
 window.addEventListener('pagehide',()=>upload?.abort());sync();
 function addSaved(file,agentId,version){sync();if(upload||files.length>=3||String(agentId)!==String(adapter.context().agentId)||version!==adapter.context().version){void removeRemote(file,agentId);adapter.status('Attachment not added: the agent changed, an upload is running, or three files are already attached.');return false}files.push({...file,agentId});render();adapter.status('Saved file attached for this message. Extracted text goes to the AI only after Send and confirmation.');return true}
 return {sync,prepareSend,addDownloads,addSaved};
}
