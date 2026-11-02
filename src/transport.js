import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { MAX_AUDIO_BYTES } from './audio.js';

const MAX_JSON_BYTES=48*1024*1024;
const WS_GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const loopback=url=>['localhost','127.0.0.1','[::1]'].includes(url.hostname);

export function requestUrl(value){
  const url=new URL(value);
  if(url.username||url.password||url.hash||(url.protocol!=='https:'&&!(url.protocol==='http:'&&loopback(url))))throw new Error('TTS 请求地址必须使用 HTTPS，本机可使用 HTTP。');
  return url;
}

export function wsRequestUrl(value){
  const url=new URL(value);
  if(url.username||url.password||url.hash||(url.protocol!=='wss:'&&!(url.protocol==='ws:'&&loopback(url))))throw new Error('TTS WebSocket 地址必须使用 WSS，本机可使用 WS。');
  return url;
}

async function readBounded(response,limit,label){
  if(!response.ok){
    await response.body?.cancel();
    throw new Error(`TTS HTTP ${response.status}：请检查凭据、模型权限或服务额度。`);
  }
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error(label);}
  if(!response.body)throw new Error('TTS 返回了空响应。');
  const chunks=[];let size=0;
  const reader=response.body.getReader();
  try{
    while(true){
      const {value,done}=await reader.read();if(done)break;
      size+=value.byteLength;
      if(size>limit){await reader.cancel();throw new Error(label);}
      chunks.push(Buffer.from(value));
    }
  }finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}

async function send(url,body,headers,signal,limit,label){
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
  const response=await fetch(requestUrl(url),{method:'POST',redirect:'manual',signal:combined,
    headers:{'content-type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
  return readBounded(response,limit,label);
}

export async function postAudio(url,body,headers={},signal){return send(url,body,headers,signal,MAX_AUDIO_BYTES,'TTS 音频超过 16 MB。');}
export async function getJson(url,headers={},signal){
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
  const response=await fetch(requestUrl(url),{method:'GET',headers,redirect:'manual',signal:combined,credentials:'omit'});
  const bytes=await readBounded(response,4*1024*1024,'TTS 目录响应超过 4 MB。');
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error('TTS 服务返回了无效的 JSON。');}
}
export async function postJson(url,body,headers={},signal){
  const bytes=await send(url,body,headers,signal,MAX_JSON_BYTES,'TTS JSON 响应超过 48 MB。');
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw new Error('TTS 服务返回了无效的 JSON。');}
}
export async function postJsonLines(url,body,headers={},signal){
  const bytes=await send(url,body,headers,signal,MAX_JSON_BYTES,'TTS JSON 响应超过 48 MB。');
  const frames=[];
  for(let line of bytes.toString('utf8').split(/\r?\n/)){
    line=line.trim();if(!line||line.startsWith(':')||line.startsWith('event:')||line==='data: [DONE]')continue;
    if(line.startsWith('data:'))line=line.slice(5).trim();
    try{frames.push(JSON.parse(line));}catch{throw new Error('TTS 服务返回了无效的流式 JSON。');}
  }
  if(!frames.length)throw new Error('TTS 没有返回音频数据帧。');
  return frames;
}

export async function downloadAudio(value,signal,{baseUrl,allowedSuffixes=[]}={}){
  const url=new URL(value),base=baseUrl?new URL(baseUrl):null;
  const fixture=base&&loopback(base)&&url.origin===base.origin;
  const allowed=allowedSuffixes.some(suffix=>suffix.startsWith('.')?url.hostname.endsWith(suffix):url.hostname===suffix);
  if(!fixture&&!allowed)throw new Error('TTS 音频下载地址不属于当前服务的已知域名。');
  if(!fixture&&loopback(url))throw new Error('TTS 音频下载地址不能指向本机。');
  if(!fixture&&url.protocol==='http:')url.protocol='https:';
  requestUrl(url);
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
  const response=await fetch(url,{method:'GET',redirect:'manual',signal:combined,credentials:'omit'});
  return readBounded(response,MAX_AUDIO_BYTES,'TTS 音频超过 16 MB。');
}

export function encodeWsFrame(opcode,payload){
  const data=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
  const len=data.length;
  const mask=crypto.randomBytes(4);
  let offset=2;
  if(len>=65536)offset=10;
  else if(len>=126)offset=4;
  const frame=Buffer.allocUnsafe(offset+4+len);
  frame[0]=0x80|(opcode&0x0f);
  if(len<126){
    frame[1]=0x80|len;
  }else if(len<65536){
    frame[1]=0x80|126;
    frame.writeUInt16BE(len,2);
  }else{
    frame[1]=0x80|127;
    frame.writeBigUInt64BE(BigInt(len),2);
  }
  mask.copy(frame,offset);
  for(let i=0;i<len;i++)frame[offset+4+i]=data[i]^mask[i&3];
  return frame;
}

export function openWebSocket(value,{headers={},signal,timeoutMs=15000}={}){
  const target=wsRequestUrl(value);
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  if(combined.aborted)return Promise.reject(combined.reason??new DOMException('操作已取消。','AbortError'));

  return new Promise((resolve,reject)=>{
    let handshakeDone=false;
    let closed=false;
    let socket=null;
    let req=null;
    let handlers={onJson:null,onBinary:null,onError:null,onClose:null};
    const pendingEvents=[];
    const key=crypto.randomBytes(16).toString('base64');
    const expectedAccept=crypto.createHash('sha1').update(key+WS_GUID).digest('base64');
    const mod=target.protocol==='wss:'?https:http;
    const httpTarget=new URL(target);
    httpTarget.protocol=target.protocol==='wss:'?'https:':'http:';

    const closeSocket=sendCloseFrame=>{
      if(closed)return;
      closed=true;
      combined.removeEventListener('abort',onHandshakeAbort);
      if(!handshakeDone&&req&&!req.destroyed)req.destroy();
      if(socket&&!socket.destroyed){
        if(sendCloseFrame&&socket.writable){
          try{socket.end(encodeWsFrame(0x8,Buffer.alloc(0)));}catch{}
        }
        try{socket.destroy();}catch{}
      }
    };

    const emitError=err=>{
      if(closed)return;
      const error=err instanceof Error?err:new Error(String(err));
      if(!handshakeDone){
        closeSocket(false);
        reject(error);
        return;
      }
      closeSocket(false);
      if(handlers.onError)handlers.onError(error);
      else pendingEvents.push({type:'error',error});
    };

    const onHandshakeAbort=()=>emitError(combined.reason??new DOMException('操作已取消。','AbortError'));
    combined.addEventListener('abort',onHandshakeAbort,{once:true});

    req=mod.request(httpTarget,{
      method:'GET',
      headers:{
        Connection:'Upgrade',
        Upgrade:'websocket',
        'Sec-WebSocket-Version':'13',
        'Sec-WebSocket-Key':key,
        ...headers,
      },
    });
    req.on('error',err=>emitError(err));
    req.on('response',res=>{
      res.resume();
      emitError(new Error(`TTS HTTP ${res.statusCode}：请检查凭据、模型权限或服务额度。`));
    });
    req.on('upgrade',(res,sock,head)=>{
      if(closed||combined.aborted){sock.destroy();return;}
      combined.removeEventListener('abort',onHandshakeAbort);
      socket=sock;
      socket.setNoDelay(true);
      const accept=res.headers['sec-websocket-accept'];
      if(accept!==expectedAccept){
        emitError(new Error('TTS WebSocket 握手校验失败。'));
        return;
      }
      handshakeDone=true;
      let buf=head?.length?Buffer.from(head):Buffer.alloc(0);
      let fragOpcode=0;
      let fragChunks=[];
      let fragSize=0;

      const dispatch=(opcode,payload)=>{
        if(closed)return;
        if(opcode===0x1){
          let msg;
          try{msg=JSON.parse(payload.toString('utf8'));}
          catch{emitError(new Error('TTS 服务返回了无效的流式 JSON。'));return;}
          if(handlers.onJson)Promise.resolve(handlers.onJson(msg,conn)).catch(emitError);
          else pendingEvents.push({type:'json',msg});
        }else if(opcode===0x2){
          if(handlers.onBinary)Promise.resolve(handlers.onBinary(payload,conn)).catch(emitError);
          else pendingEvents.push({type:'binary',payload});
        }
      };

      const parse=()=>{
        while(!closed&&buf.length>=2){
          const b0=buf[0],b1=buf[1];
          const fin=(b0&0x80)!==0;
          const opcode=b0&0x0f;
          const masked=(b1&0x80)!==0;
          let len=b1&0x7f;
          let offset=2;
          if(len===126){
            if(buf.length<4)return;
            len=buf.readUInt16BE(2);
            offset=4;
          }else if(len===127){
            if(buf.length<10)return;
            const big=buf.readBigUInt64BE(2);
            if(big>BigInt(MAX_AUDIO_BYTES)){emitError(new Error('TTS 音频超过 16 MB。'));return;}
            len=Number(big);
            offset=10;
          }
          if(len>MAX_AUDIO_BYTES){emitError(new Error('TTS 音频超过 16 MB。'));return;}
          const maskLen=masked?4:0;
          if(buf.length<offset+maskLen+len)return;
          let payload=buf.subarray(offset+maskLen,offset+maskLen+len);
          if(masked){
            const mask=buf.subarray(offset,offset+4);
            const copy=Buffer.allocUnsafe(len);
            for(let i=0;i<len;i++)copy[i]=payload[i]^mask[i&3];
            payload=copy;
          }else{
            payload=Buffer.from(payload);
          }
          buf=buf.subarray(offset+maskLen+len);
          if(opcode===0x8){
            closeSocket(false);
            if(handlers.onClose)handlers.onClose();
            else pendingEvents.push({type:'close'});
            return;
          }
          if(opcode===0x9){
            if(socket?.writable)socket.write(encodeWsFrame(0x0a,payload));
            continue;
          }
          if(opcode===0x0a)continue;
          if(opcode!==0x0){
            if(!fin){
              fragOpcode=opcode;
              fragChunks=[payload];
              fragSize=payload.length;
            }else{
              dispatch(opcode,payload);
            }
          }else{
            fragSize+=payload.length;
            if(fragSize>MAX_AUDIO_BYTES){emitError(new Error('TTS 音频超过 16 MB。'));return;}
            fragChunks.push(payload);
            if(fin){
              const full=Buffer.concat(fragChunks,fragSize);
              const op=fragOpcode;
              fragOpcode=0;fragChunks=[];fragSize=0;
              dispatch(op,full);
            }
          }
        }
      };

      const conn={
        get alive(){return !closed&&Boolean(socket&&!socket.destroyed&&socket.writable);},
        sendJson(obj){
          if(closed||!socket?.writable)return;
          const text=typeof obj==='string'?obj:JSON.stringify(obj);
          socket.write(encodeWsFrame(0x1,Buffer.from(text,'utf8')));
        },
        setHandlers(next={}){
          handlers={...handlers,...next};
          while(pendingEvents.length){
            const ev=pendingEvents.shift();
            if(ev.type==='json'&&handlers.onJson)Promise.resolve(handlers.onJson(ev.msg,conn)).catch(emitError);
            else if(ev.type==='binary'&&handlers.onBinary)Promise.resolve(handlers.onBinary(ev.payload,conn)).catch(emitError);
            else if(ev.type==='error'&&handlers.onError){handlers.onError(ev.error);break;}
            else if(ev.type==='close'&&handlers.onClose){handlers.onClose();break;}
          }
        },
        unref(){socket?.unref?.();},
        ref(){socket?.ref?.();},
        close(sendFrame=true){closeSocket(sendFrame);},
      };

      socket.on('data',chunk=>{
        if(closed)return;
        buf=buf.length?Buffer.concat([buf,chunk]):chunk;
        parse();
      });
      socket.on('error',err=>emitError(err));
      socket.on('close',()=>{
        if(!closed){
          closed=true;
          if(handlers.onClose)handlers.onClose();
          else pendingEvents.push({type:'close'});
        }
      });
      if(buf.length)parse();
      resolve(conn);
    });
    req.end();
  });
}

export function runWebSocket(value,{headers={},signal,timeoutMs=45000,onOpen,onJson,onBinary}={}){
  const combined=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
  if(combined.aborted)return Promise.reject(combined.reason??new DOMException('操作已取消。','AbortError'));

  return new Promise((resolve,reject)=>{
    let settled=false;
    let activeConn=null;
    const finish=result=>{
      if(settled)return;
      settled=true;
      combined.removeEventListener('abort',onAbort);
      activeConn?.close(true);
      resolve(result);
    };
    const fail=err=>{
      if(settled)return;
      settled=true;
      combined.removeEventListener('abort',onAbort);
      activeConn?.close(false);
      reject(err instanceof Error?err:new Error(String(err)));
    };
    const onAbort=()=>fail(combined.reason??new DOMException('操作已取消。','AbortError'));
    combined.addEventListener('abort',onAbort,{once:true});

    openWebSocket(value,{headers,signal:combined,timeoutMs}).then(conn=>{
      if(settled){conn.close(false);return;}
      activeConn=conn;
      const ws={
        sendJson:obj=>conn.sendJson(obj),
        finish,
        fail,
      };
      conn.setHandlers({
        onJson:(msg)=>onJson?.(msg,ws),
        onBinary:(payload)=>onBinary?.(payload,ws),
        onError:err=>fail(err),
        onClose:()=>fail(new Error('TTS WebSocket 连接已关闭，未完成音频合成。')),
      });
      Promise.resolve(onOpen?.(ws)).catch(fail);
    },fail);
  });
}
