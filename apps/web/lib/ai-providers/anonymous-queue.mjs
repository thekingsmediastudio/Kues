// Per-process conservative admission gate for the OVH anonymous endpoint.
// Other processes and clients sharing an egress IP can still consume the upstream quota.
export function createAnonymousQueue({limit=2,windowMs=65_000,maxQueued=3,maxWaitMs=140_000,now=Date.now}={}) {
  const started=[];const waiting=[];let timer=null;
  const err=(code)=>Object.assign(new Error(code),{code});
  function cancelTimer(){if(timer){clearTimeout(timer);timer=null}}
  function pump(){
    cancelTimer();const time=now();while(started.length&&started[0]<=time-windowMs)started.shift();
    while(waiting.length&&started.length<limit){const item=waiting.shift();item.cleanup();if(item.signal?.aborted){item.reject(err('anonymous_queue_cancelled'));continue}started.push(now());item.resolve()}
    if(waiting.length&&started.length){timer=setTimeout(pump,Math.max(1,started[0]+windowMs-now()));timer.unref?.()}
  }
  function enter({signal,onQueued}={}){
    if(signal?.aborted)return Promise.reject(err('anonymous_queue_cancelled'));
    const time=now();while(started.length&&started[0]<=time-windowMs)started.shift();
    if(!waiting.length&&started.length<limit){started.push(time);return Promise.resolve()}
    if(waiting.length>=maxQueued)return Promise.reject(err('anonymous_queue_busy'));
    return new Promise((resolve,reject)=>{
      let deadline,heartbeat;
      const item={signal,resolve,reject,cleanup(){clearTimeout(deadline);clearInterval(heartbeat);signal?.removeEventListener('abort',abort)}};
      function remove(code){const index=waiting.indexOf(item);if(index<0)return;waiting.splice(index,1);item.cleanup();reject(err(code));pump()}
      function abort(){remove('anonymous_queue_cancelled')}
      waiting.push(item);signal?.addEventListener('abort',abort,{once:true});
      deadline=setTimeout(()=>remove('anonymous_queue_busy'),maxWaitMs);deadline.unref?.();
      // Status callbacks must not cause an unhandled rejection or expose queue contents.
      const notify=()=>{try{Promise.resolve(onQueued?.()).catch(()=>{})}catch{}};notify();
      if(onQueued){heartbeat=setInterval(notify,15_000);heartbeat.unref?.()}
      pump();
    });
  }
  return Object.freeze({enter});
}
