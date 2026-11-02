// Development harness for the actual extension panel. No external service or installed data is used.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { NaturalVoiceWorld } from '../src/world.js';
import { DEFAULTS, KEY_NAME, validateConfig } from '../src/config.js';
import { getBuiltinCatalog } from '../src/catalog.js';

const cfg = { ...DEFAULTS, enabled: true };
const secrets = new Map();
let cursor = 0, lastSpoken = '';
const events = [];
const world = new NaturalVoiceWorld({ cfg, secret: name => secrets.get(name) ?? '', storeSecret: (name, value) => { secrets.set(name, value); } }, {
  catalog:async config=>getBuiltinCatalog(config),
  synthesize: async (config, key, text, signal) => { signal.throwIfAborted(); lastSpoken = text; return Buffer.alloc(0); },
  play: async (bytes, signal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 2500);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  },
});
await world.start({ store: { latestCursor: () => cursor, range: q => events.filter(e => e.cursor >= q.fromCursor && e.cursor <= q.toCursor) }, log: { warn: console.warn } });

const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>自然语音扩展 · 本地面板检查</title><link rel="stylesheet" href="/web/style.css">
<style>body{font:15px/1.6 system-ui;margin:32px;background:#f6f7f8;color:#25272b}main{max-width:820px;margin:auto;background:white;padding:28px;border:1px solid #ddd;border-radius:10px}h1{margin:0 0 8px;font-size:24px}.hint{color:#666;font-size:13px;margin-bottom:24px}button{padding:9px 16px;border:1px solid #aaa7;border-radius:6px;cursor:pointer;background:white;color:inherit}button:disabled{opacity:.45;cursor:default}.primary{background:#242a36;color:white}button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid #4263eb;outline-offset:2px}@media(max-width:540px){body{margin:10px}main{padding:18px}}</style>
<main><h1>自然语音</h1><p class="hint">开发面板检查：使用扩展原始面板代码，语音生成与播放为本机模拟。</p><div id="root"></div><button id="reply">发送测试回复</button><output id="last"></output></main>
<script type="module">
import client from '/web/client.js';
const controller = new AbortController();
async function post(path, body) { const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}); const d=await r.json(); if(!r.ok) throw new Error(d.error); return d; }
const ctx={language:'zh',root:document.querySelector('#root'),signal:controller.signal,
 ui:{h(tag,cls,text){const el=document.createElement(tag);if(cls)el.className=cls;if(text!=null)el.textContent=text;return el;}},
 invoke(method,args){if(args!==undefined&&!Array.isArray(args))return Promise.reject(new Error('ctx.invoke args must be an array'));return post('/invoke',{method,args:args??[]});},
 setConfig(groupId,values){return post('/config',{groupId,values});},refresh:async()=>{},
 interval(fn,ms){const id=setInterval(fn,ms);controller.signal.addEventListener('abort',()=>clearInterval(id));return{dispose(){clearInterval(id)}};}};
await client.panels.voice.mount(ctx);
document.querySelector('#reply').onclick=async()=>{await post('/reply',{});};
setInterval(async()=>{const r=await fetch('/last');const d=await r.json();document.querySelector('#last').textContent=d.lastSpoken?'最近朗读：'+d.lastSpoken:'';},500);
window.addEventListener('pagehide',()=>controller.abort());
</script></html>`;

let origin;
const server = createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  if (req.headers.host !== new URL(origin).host || (req.method === 'POST' && req.headers.origin !== origin)) { json(403, { error: 'Origin refused' }); return; }
  try {
    if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (req.url === '/' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
    if (req.url === '/web/client.js' || req.url === '/web/style.css') {
      res.writeHead(200, { 'content-type': req.url.endsWith('.js') ? 'text/javascript' : 'text/css' });
      res.end(await readFile(new URL('..' + req.url, import.meta.url))); return;
    }
    if (req.url === '/last') { json(200, { lastSpoken }); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Body too large'); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/invoke') { json(200, await world.webUi('zh').invoke('voice', data.method, data.args)); return; }
    if (req.url === '/config') {
      const next = { ...cfg };
      for (const [name, value] of Object.entries(data.values)) next[name.slice('worlds.natural-voice.'.length)] = value;
      validateConfig(next); Object.assign(cfg, next); json(200, 'Saved'); return;
    }
    if (req.url === '/reply') {
      events.push({ cursor: ++cursor, type: 'desktop-pet.self', source: 'desktop-pet', meta: { kind: 'say', beats: [{ text: '这是新回复，会自动加入朗读队列。' }] } });
      json(200, { ok: true }); return;
    }
    json(404, { error: 'Unknown route' });
  } catch (error) { json(400, { error: error.message }); }
});
server.listen(0, '127.0.0.1', () => { origin = `http://127.0.0.1:${server.address().port}`; console.log(origin); });
