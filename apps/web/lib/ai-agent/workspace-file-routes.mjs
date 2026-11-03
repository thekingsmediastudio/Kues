import {LibraryError,LIBRARY_FILE_BYTES} from './workspace-storage.mjs';
import {FileToolError} from './file-tools.mjs';
export const STORAGE_CONSENT='workspace-storage-v1';
function body(req,max){return new Promise((resolve,reject)=>{let size=0,settled=false;const chunks=[];const timer=setTimeout(()=>end(new LibraryError('library_upload_timeout',408)),15000);function end(error){if(settled)return;settled=true;clearTimeout(timer);req.off('data',data);req.off('end',done);req.off('error',aborted);req.off('aborted',aborted);if(error){req.resume();reject(error)}else resolve(Buffer.concat(chunks))}function data(chunk){size+=chunk.length;if(size>max)end(new LibraryError('library_file_too_large',413));else chunks.push(chunk)}function done(){end()}function aborted(){end(new LibraryError('library_canceled',400))}req.on('data',data);req.on('end',done);req.on('error',aborted);req.on('aborted',aborted)})}
export function createWorkspaceFileRoutes({library,files,getScope,sameOrigin,executionReady=()=>false}){
 let active=0;
 const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value))};
 return async(req,res,url)=>{
  if(req.method!=='POST'){json(res,405,{error:'method_not_allowed'});return}
  if(!sameOrigin(req)){json(res,403,{error:'same_origin_required'});return}
  let counted=false;const abort=new AbortController();const close=()=>{if(!res.writableEnded)abort.abort()};res.on('close',close);
  try{
   const action=url.pathname.split('/').at(-1);if(!['status','list','upload','download','remove','attach'].includes(action))throw new LibraryError('library_route_not_found',404);
   const agentId=url.searchParams.get('agentId');if(!agentId||agentId.length>255)throw new LibraryError('file_agent_required');
   const scope=await getScope(req,agentId);if(active>=4)throw new LibraryError('library_busy',429);active++;counted=true;
   if(action==='status'){json(res,200,{configured:library.configured,executionAvailable:executionReady()===true,visionAvailable:false,visionInputAvailable:true,visionRequiresExplicitCompatibleModel:true,maxFileBytes:LIBRARY_FILE_BYTES,maxFilesPerAgent:50});return}
   if(action==='list'){json(res,200,{files:await library.list(scope)});return}
   if(action==='upload'){
    if(scope.agent.settings?.toolPermissions?.create_files!==true)throw new LibraryError('file_permission_required',403);
    if(req.headers['x-workspace-storage-consent']!==STORAGE_CONSENT)throw new LibraryError('library_consent_required');
    if(String(req.headers['content-type']).split(';')[0]!=='application/octet-stream')throw new LibraryError('file_content_type_invalid',415);
    if(Number(req.headers['content-length'])>LIBRARY_FILE_BYTES)throw new LibraryError('library_file_too_large',413);
    const bytes=await body(req,LIBRARY_FILE_BYTES);const fresh=await getScope(req,agentId);const saved=await library.upload(fresh,{path:url.searchParams.get('path'),bytes});try{const latest=await getScope(req,agentId);if(latest.agent.settings?.toolPermissions?.create_files!==true)throw new LibraryError('file_permission_required',403)}catch(e){await library.remove(fresh,saved.id);throw e}json(res,200,saved);return;
   }
   if(String(req.headers['content-type']).split(';')[0]!=='application/json')throw new LibraryError('file_content_type_invalid',415);
   let input;try{input=JSON.parse((await body(req,4096)).toString('utf8'))}catch(e){if(e instanceof LibraryError)throw e;throw new LibraryError('library_request_invalid')}
   if(!input||typeof input.id!=='string'||Object.keys(input).some(k=>k!=='id'))throw new LibraryError('library_request_invalid');
   const fresh=await getScope(req,agentId);
   if(action==='remove'){json(res,200,await library.remove(fresh,input.id));return}
   const file=await library.download(fresh,input.id);
   if(action==='attach'){
    const checked=await getScope(req,agentId);const result=await files.add({...checked,name:file.path.split('/').at(-1),bytes:file.bytes,signal:abort.signal});
    try{const latest=await getScope(req,agentId);if(latest.agent.settings?.toolPermissions?.read_files!==true)throw new LibraryError('file_permission_required',403)}catch(e){files.remove({...checked,agentId,id:result.id});throw e}
    json(res,200,result);return;
   }
   const finalScope=await getScope(req,agentId);if(finalScope.agent.settings?.toolPermissions?.read_files!==true)throw new LibraryError('file_permission_required',403);
   res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="Keus-file"; filename*=UTF-8''${encodeURIComponent(file.path.split('/').at(-1)).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,'Content-Length':file.bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'"});res.end(file.bytes);
  }catch(e){if(!res.destroyed){if([408,413].includes(e.status))res.setHeader('Connection','close');const known=e instanceof LibraryError||e instanceof FileToolError;json(res,known?e.status:503,{error:known?e.code:'library_provider_unavailable'})}}
  finally{res.off('close',close);if(counted)active--}
 };
}
