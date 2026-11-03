import crypto from 'node:crypto';
import { planDocumentContext } from './document-reading.mjs';
import { Worker } from 'node:worker_threads';
import { FILE_BYTES, fileExtension, exportReport } from './file-formats.mjs';
export const FILE_CONSENT='file-analysis-v2';
export const IMAGE_CONSENT='image-analysis-v1';
export class FileToolError extends Error { constructor(code,status=400){super(code);this.code=code;this.status=status} }
export function parseInWorker(bytes,name,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(new FileToolError('file_canceled',499));return}
  const worker=new Worker(new URL('./file-parser-worker.mjs',import.meta.url),{execArgv:[],workerData:{bytes,name},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
  let settled=false;const timer=setTimeout(()=>done(new FileToolError('file_parse_timeout',408)),30000);
  const abort=()=>done(new FileToolError('file_canceled',499));
  function done(error,result){if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);void worker.terminate();error?reject(error):resolve(result)}
  worker.once('message',message=>message.ok?done(null,message.result):done(new FileToolError(message.code)));
  worker.once('error',()=>done(new FileToolError('file_parse_failed')));
  worker.once('exit',()=>{if(!settled)done(new FileToolError('file_parse_failed'))});
  signal?.addEventListener('abort',abort,{once:true});
 });
}
export function createFileTools({parse=parseInWorker,now=Date.now}={}){
 const files=new Map(),windows=new Map();let parsing=0;
 const cleanup=()=>{for(const[id,file]of files)if(file.expiresAt<=now())files.delete(id);for(const[id,w]of windows)if(now()-w.start>=60000)windows.delete(id)};
 const allowed=(agent,key)=>{if(agent?.settings?.toolPermissions?.[key]!==true)throw new FileToolError('file_permission_required',403)};
 return {
  ready:true,
  async add({bytes,name,userId,workspaceId,agent,signal}){
   allowed(agent,'read_files');try{fileExtension(name)}catch(error){throw new FileToolError(error.message)}cleanup();
   if(!bytes.length||bytes.length>FILE_BYTES)throw new FileToolError('file_size_invalid',413);
   const w=windows.get(userId)||{start:now(),count:0};
   if(parsing>=1||w.count>=8)throw new FileToolError('file_rate_limited',429);
   if(files.size>=100||[...files.values()].filter(f=>f.userId===userId).length>=6)throw new FileToolError('file_storage_limit',429);
   w.count++;windows.set(userId,w);parsing++;
   try{const result=await parse(bytes,name,signal);if(signal?.aborted)throw new FileToolError('file_canceled',499);
    const id='file_'+crypto.randomBytes(16).toString('hex');const expiresAt=now()+15*60000;
    files.set(id,{...result,id,name,userId,workspaceId,agentId:agent.id,expiresAt});
    setTimeout(()=>files.delete(id),15*60000).unref();
    return {id,name,format:result.format,characters:result.text.length,notes:result.notes,truncated:result.truncated,sectionCount:result.sections?.length||1,totalPages:result.totalPages||null,expiresAt:new Date(expiresAt).toISOString()};
   }finally{parsing--}
  },
  context({ids,userId,workspaceId,agent,query='',hint=''}){
   allowed(agent,'read_files');cleanup();
   if(!Array.isArray(ids)||ids.length<1||ids.length>3||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^file_[0-9a-f]{32}$/.test(id)))throw new FileToolError('file_selection_invalid');
   const selected=ids.map(id=>{const f=files.get(id);if(!f||f.userId!==userId||f.workspaceId!==workspaceId||f.agentId!==agent.id)throw new FileToolError('file_unavailable',404);return {name:f.name,format:f.format,text:f.text,sections:f.sections,totalPages:f.totalPages,missingPages:f.missingPages,notes:f.notes,truncated:f.truncated,image:f.image}});
   const images=selected.filter(f=>f.format==='image');
   if(images.length){if(images.length!==selected.length)throw new FileToolError('file_image_combination_unsupported');return {mode:'images',files:images.map(f=>({name:f.name,format:'image',notes:f.notes,coverage:{mode:'image'}})),images:images.map(f=>({name:f.name,...f.image}))}}
   try{return planDocumentContext(selected,query,hint)}catch(error){if(error.code==='file_review_limit')throw new FileToolError(error.code,413);throw error}
  },
  remove({id,userId,workspaceId,agentId}){const f=files.get(id);if(f&&f.userId===userId&&f.workspaceId===workspaceId&&f.agentId===agentId)files.delete(id)},
  export({agent,text,format}){allowed(agent,'create_files');try{return exportReport(text,format)}catch(error){throw new FileToolError(error.message)}}
 };
}
function readBounded(req,max){return new Promise((resolve,reject)=>{
 let size=0;const chunks=[];const timer=setTimeout(()=>done(new FileToolError('file_upload_timeout',408)),15000);
 function done(error){clearTimeout(timer);req.off('data',data);req.off('end',end);req.off('error',abort);req.off('aborted',abort);if(error){req.resume();reject(error)}else resolve(Buffer.concat(chunks))}
 function data(chunk){size+=chunk.length;if(size>max)done(new FileToolError('file_size_invalid',413));else chunks.push(chunk)}
 function end(){done()}function abort(){done(new FileToolError('file_canceled',400))}
 req.on('data',data);req.on('end',end);req.on('error',abort);req.on('aborted',abort);
})}
export function createFileRoutes({service,getScope,sameOrigin}){
 let activeRequests=0;
 const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data))};
 return async(req,res,url)=>{
  if(!['/api/files/upload','/api/files/remove','/api/files/export'].includes(url.pathname)){send(res,404,{error:'file_route_not_found'});return}
  if(req.method!=='POST'){send(res,405,{error:'method_not_allowed'});return}
  if(!sameOrigin(req)){send(res,403,{error:'same_origin_required'});return}
  let counted=false;
  const controller=new AbortController();const abort=()=>{if(!res.writableEnded)controller.abort()};res.on('close',abort);
  try{
   const agentId=url.searchParams.get('agentId');if(!agentId||agentId.length>255)throw new FileToolError('file_agent_required');
   const scope=await getScope(req,agentId);
   if(activeRequests>=4)throw new FileToolError('file_rate_limited',429);activeRequests++;counted=true;
   if(url.pathname==='/api/files/upload'){
    if(scope.agent.settings?.toolPermissions?.read_files!==true)throw new FileToolError('file_permission_required',403);
    if(String(req.headers['content-type']||'').split(';')[0]!=='application/octet-stream')throw new FileToolError('file_content_type_invalid',415);
    if(Number(req.headers['content-length'])>FILE_BYTES)throw new FileToolError('file_size_invalid',413);
    const name=url.searchParams.get('name');try{fileExtension(name)}catch(error){throw new FileToolError(error.message)}
    const bytes=await readBounded(req,FILE_BYTES);const result=await service.add({...scope,bytes,name,signal:controller.signal});
    try{const fresh=await getScope(req,agentId);if(fresh.agent.settings?.toolPermissions?.read_files!==true)throw new FileToolError('file_permission_required',403)}catch(error){service.remove({...scope,agentId,id:result.id});throw error}
    if(!res.destroyed)send(res,200,result);
   }else{
    if(String(req.headers['content-type']||'').split(';')[0]!=='application/json')throw new FileToolError('file_content_type_invalid',415);
    let body;try{body=JSON.parse((await readBounded(req,256*1024)).toString('utf8'))}catch(error){if(error instanceof FileToolError)throw error;throw new FileToolError('file_request_invalid')}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new FileToolError('file_request_invalid');
    if(url.pathname==='/api/files/remove'){service.remove({...scope,agentId,id:body.id});send(res,200,{removed:true})}
    else{const output=service.export({agent:scope.agent,text:body.text,format:body.format});res.writeHead(200,{'Content-Type':output.mime,'Content-Disposition':`attachment; filename="Keus-report.${body.format}"`,'Content-Length':output.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(output.bytes)}
   }
  }catch(error){if(!res.destroyed){if([408,413].includes(error.status))res.setHeader('Connection','close');const known=error instanceof FileToolError;send(res,known?error.status:400,{error:known?error.code:'file_parse_failed'})}}
  finally{res.off('close',abort);if(counted)activeRequests--}
 };
}
