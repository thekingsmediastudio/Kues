import crypto from 'node:crypto';
import {S3Client,GetBucketAclCommand,ListObjectsV2Command,PutObjectCommand,GetObjectCommand,ListObjectVersionsCommand,DeleteObjectCommand} from '@aws-sdk/client-s3';
export const LIBRARY_FILE_BYTES=5*1024*1024;
export class LibraryError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status}}
const fail=(code,status)=>{throw new LibraryError(code,status)};
export function libraryScope({userId,workspaceId,agent}){
 if([userId,workspaceId,agent?.id].some(v=>typeof v!=='string'||!v||v.length>255))fail('library_scope_invalid');
 const hash=values=>crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex');
 return `keus-v1/${hash([userId,workspaceId])}/${hash([agent.id])}/`;
}
export function libraryPath(value){
 if(typeof value!=='string'||value.length>240||value!==value.normalize('NFC')||/[\\\u0000-\u001f\u007f]/.test(value))fail('library_path_invalid');
 const parts=value.split('/');if(parts.length>5||parts.some(p=>!p||p==='.'||p==='..'||p!==p.trim()||p.length>160))fail('library_path_invalid');
 return value;
}
export function createB2Storage({endpoint,region,bucket,keyId,key,client}={}){
 if(!endpoint||!region||!bucket||(!client&&(!keyId||!key)))fail('library_not_configured',503);
 let url;try{url=new URL(endpoint)}catch{fail('library_config_invalid',503)}
 if(url.protocol!=='https:'||url.hostname!==`s3.${region}.backblazeb2.com`||url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!/^[a-z0-9-]{3,63}$/.test(bucket))fail('library_config_invalid',503);
 const s3=client||new S3Client({region,endpoint:url.origin,forcePathStyle:true,maxAttempts:1,credentials:{accessKeyId:keyId,secretAccessKey:key},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
 const send=command=>s3.send(command,{abortSignal:AbortSignal.timeout(20000)});
 async function privateBucket(){const acl=await send(new GetBucketAclCommand({Bucket:bucket}));if(typeof acl.Owner?.ID!=='string'||!acl.Owner.ID||!Array.isArray(acl.Grants)||!acl.Grants.length||acl.Grants.some(g=>g.Grantee?.Type!=='CanonicalUser'||g.Grantee?.ID!==acl.Owner?.ID))fail('library_bucket_not_private',503)}
 return {
  async list(prefix){await privateBucket();const r=await send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:101}));if(r.IsTruncated)fail('library_storage_limit',429);return(r.Contents||[]).map(o=>({key:o.Key,size:o.Size,modifiedAt:o.LastModified?.toISOString()}))},
  async put(key,bytes){await privateBucket();const sha=crypto.createHash('sha256').update(bytes).digest('hex');const result=await send(new PutObjectCommand({Bucket:bucket,Key:key,Body:bytes,ContentLength:bytes.length,ContentType:'application/octet-stream',ServerSideEncryption:'AES256',Metadata:{sha256:sha}}));return{versionId:result.VersionId,sha256:sha}},
  async get(key){await privateBucket();const r=await send(new GetObjectCommand({Bucket:bucket,Key:key}));if(!Number.isSafeInteger(r.ContentLength)||r.ContentLength<1||r.ContentLength>LIBRARY_FILE_BYTES){r.Body?.destroy?.();fail('library_file_too_large',413)}let size=0;const chunks=[];const timer=setTimeout(()=>r.Body?.destroy?.(new Error('timeout')),20000);try{for await(const chunk of r.Body){size+=chunk.length;if(size>LIBRARY_FILE_BYTES)fail('library_file_too_large',413);chunks.push(chunk)}}finally{clearTimeout(timer);r.Body?.destroy?.()}const bytes=Buffer.concat(chunks);if(bytes.length!==r.ContentLength||crypto.createHash('sha256').update(bytes).digest('hex')!==r.Metadata?.sha256)fail('library_integrity_failed',502);return bytes},
  async remove(key){await privateBucket();const versions=await send(new ListObjectVersionsCommand({Bucket:bucket,Prefix:key,MaxKeys:101}));if(versions.IsTruncated)fail('library_delete_limit',409);for(const v of [...(versions.Versions||[]),...(versions.DeleteMarkers||[])])if(v.Key===key&&v.VersionId)await send(new DeleteObjectCommand({Bucket:bucket,Key:key,VersionId:v.VersionId}))},
 };
}
export function createWorkspaceLibrary({store}={}){
 const pending=new Set();
 const allowed=(scope,key)=>{libraryScope(scope);if(scope.agent?.settings?.toolPermissions?.[key]!==true)fail('file_permission_required',403);if(!store)fail('library_not_configured',503)};
 const items=async scope=>{const prefix=libraryScope(scope);const rows=await store.list(prefix);return rows.filter(row=>typeof row.key==='string'&&row.key.startsWith(prefix)).map(row=>{const rest=row.key.slice(prefix.length),slash=rest.indexOf('/');const id=rest.slice(0,slash);if(!/^saved_[0-9a-f]{32}$/.test(id))return null;try{const path=libraryPath(decodeURIComponent(rest.slice(slash+1)));if(!Number.isSafeInteger(row.size)||row.size<1||row.size>LIBRARY_FILE_BYTES)return null;return {id,path,size:row.size,modifiedAt:row.modifiedAt,key:row.key}}catch{return null}}).filter(Boolean)};
 const publicItem=({key,...item})=>item;
 const find=async(scope,id)=>{if(!/^saved_[0-9a-f]{32}$/.test(String(id)))fail('library_file_unavailable',404);const file=(await items(scope)).find(f=>f.id===id);if(!file)fail('library_file_unavailable',404);return file};
 return {
  configured:Boolean(store),
  async list(scope){allowed(scope,'read_files');return(await items(scope)).map(publicItem)},
  async upload(scope,{path,bytes}){allowed(scope,'create_files');libraryPath(path);if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>LIBRARY_FILE_BYTES)fail('library_file_too_large',413);const prefix=libraryScope(scope);if(pending.has(prefix))fail('library_busy',429);pending.add(prefix);try{const existing=await items(scope);if(existing.length>=50||existing.reduce((s,f)=>s+f.size,0)+bytes.length>100*1024*1024)fail('library_storage_limit',429);const id='saved_'+crypto.randomBytes(16).toString('hex'),key=prefix+id+'/'+encodeURIComponent(path);await store.put(key,bytes);return {id,path,size:bytes.length,modifiedAt:new Date().toISOString()}}finally{pending.delete(prefix)}},
  async download(scope,id){allowed(scope,'read_files');const file=await find(scope,id);return {...publicItem(file),bytes:await store.get(file.key)}},
  async remove(scope,id){libraryScope(scope);if(!store)fail('library_not_configured',503);const file=await find(scope,id);await store.remove(file.key);return{removed:true}},
 };
}
export function workspaceLibraryFromEnv(env=process.env){
 if(env.WORKSPACE_LIBRARY_ENABLED!=='1')return createWorkspaceLibrary();
 if(env.B2_FREE_CAPS_CONFIRMED!=='1')return createWorkspaceLibrary();
 return createWorkspaceLibrary({store:createB2Storage({endpoint:env.B2_S3_ENDPOINT,region:env.B2_REGION,bucket:env.B2_BUCKET,keyId:env.B2_KEY_ID,key:env.B2_APPLICATION_KEY})});
}
