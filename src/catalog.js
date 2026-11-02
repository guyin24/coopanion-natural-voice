import { normalizeConfig, validateConfig, PROVIDERS, PRESETS, DEFAULTS } from './config.js';
import { builtinAliyunCatalog, fetchAliyunCatalog } from './catalogs/aliyun.js';
import { builtinRegionalCatalog } from './catalogs/regional.js';
import { builtinRemoteCatalog, fetchRemoteCatalog } from './catalogs/remote.js';

const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/.test(value);

export function sanitizeCatalog(value={},secrets=[]) {
  const sensitive=secrets.filter(item=>typeof item==='string'&&item).sort((a,b)=>b.length-a.length);
  const safeIdentifier=value=>identifier(value)&&!sensitive.some(secret=>value.includes(secret));
  const clean=value=>{
    let text=typeof value==='string'?value:'';
    for(const secret of sensitive)text=text.split(secret).join('[redacted]');
    return text.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,1024);
  };
  const items=values=>{
    const result=[],seen=new Set();
    for(const entry of Array.isArray(values)?values:[]){
      if(!entry||!safeIdentifier(entry.id)||seen.has(entry.id))continue;
      seen.add(entry.id);
      result.push({id:entry.id,label:clean(entry.label)||entry.id,
        ...(Array.isArray(entry.models)?{models:entry.models.filter(safeIdentifier).slice(0,100)}:{}),
        ...(identifier(entry.locale)?{locale:clean(entry.locale)}:{}),
        ...(['system','custom'].includes(entry.kind)?{kind:entry.kind}:{})});
      if(result.length>=2000)break;
    }
    return result;
  };
  return {models:items(value.models),voices:items(value.voices),
    source:['live','mixed','preset'].includes(value.source)?value.source:'preset',note:clean(value.note)};
}

export function getBuiltinCatalog(input) {
  const cfg=normalizeConfig(input);
  const result=cfg.provider==='aliyun'?builtinAliyunCatalog():['tencent','volcengine'].includes(cfg.provider)
    ?builtinRegionalCatalog(cfg.provider):builtinRemoteCatalog(cfg.provider);
  return sanitizeCatalog(result);
}

export async function discoverCatalog(input,credentials={},signal) {
  const cfg=normalizeConfig(input),fallback=getBuiltinCatalog(cfg);
  if(['tencent','volcengine'].includes(cfg.provider))return fallback;
  const values=Object.values(credentials);
  if(PROVIDERS[cfg.provider].credentials.some(field=>field.required&&!credentials[field.id])) {
    return {...fallback,note:[fallback.note,'保存此平台凭据后会自动读取账号目录；也可手动输入 ID。'].filter(Boolean).join(' ')};
  }
  // Discovery needs a valid address, not an already chosen synthesis model or
  // voice. Use neutral preset fields solely to reuse endpoint validation.
  try{cfg.endpoint=validateConfig({...cfg,model:PRESETS[cfg.provider].model||'catalog',voice:PRESETS[cfg.provider].voice||'catalog',speed:1,sampleRate:PRESETS[cfg.provider].sampleRate,maxChars:DEFAULTS.maxChars});}catch{
    return {...fallback,note:[fallback.note,'请先填写完整的平台地址、地域或 Workspace ID，再刷新列表。'].filter(Boolean).join(' ')};
  }
  const timeout=AbortSignal.timeout(20000),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
    const result=await (cfg.provider==='aliyun'?fetchAliyunCatalog:fetchRemoteCatalog)(cfg,credentials,combined);
    combined.throwIfAborted();
    return sanitizeCatalog(result,values);
  }catch{
    return {...fallback,note:'在线目录暂时无法读取，已保留官方预设；可刷新重试或手动输入 ID。'};
  }
}
