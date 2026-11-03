import sharp from 'sharp';
const MAX_INPUT_PIXELS=8_000_000;
export async function parseImage(bytes,name){
 const data=Buffer.from(bytes),ext=String(name).toLowerCase().split('.').at(-1);
 const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const jpeg=data[0]===255&&data[1]===216&&data[2]===255;
 if(!((ext==='png'&&png)||(['jpg','jpeg'].includes(ext)&&jpeg)))throw Error('file_image_invalid');
 try{
  sharp.cache(false);sharp.concurrency(1);
  const decoder=sharp(data,{limitInputPixels:MAX_INPUT_PIXELS,failOn:'warning',animated:false});
  const meta=await decoder.metadata();
  if(!['png','jpeg'].includes(meta.format)||!meta.width||!meta.height||meta.width*meta.height>MAX_INPUT_PIXELS||(meta.pages||1)>1)throw Error('file_image_invalid');
  // Re-encoding strips metadata and trailing payloads. Original bytes are never sent upstream.
  const {data:encoded,info}=await decoder.rotate().resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:85}).toBuffer({resolveWithObject:true});
  if(encoded.length>2*1024*1024)throw Error('file_image_invalid');
  return {format:'image',text:'',sections:[],truncated:false,totalPages:null,notes:['Image re-encoded without metadata; longest side at most 1024 pixels. Small text and details may be lost.'],image:{mimeType:'image/jpeg',dataUrl:'data:image/jpeg;base64,'+encoded.toString('base64'),width:info.width,height:info.height}};
 }catch{throw Error('file_image_invalid')}
}
