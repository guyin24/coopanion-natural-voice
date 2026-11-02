import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize } from '../src/tts.js';
import { DEFAULTS, PRESETS } from '../src/config.js';
import { validateWave } from '../src/audio.js';
import { serverFor, wave } from './helpers.js';

for(const provider of ['siliconflow','openai','compatible','aliyun','volcengine','tencent','minimax','elevenlabs','azure']){
  test('public synthesis router selects '+provider+' protocol and returns WAV',async t=>{
    const pcm=Buffer.from([1,0,2,0]);let received,endpoint;
    endpoint=await serverFor(t,async(req,res)=>{
      if(req.method==='GET'){assert.equal(req.headers.authorization,undefined);res.end(wave());return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const raw=Buffer.concat(chunks).toString();
      received={headers:req.headers,body:provider==='azure'?raw:JSON.parse(raw)};
      res.setHeader('content-type','application/json');
      if(provider==='aliyun')res.end(JSON.stringify({output:{finish_reason:'stop',audio:{url:endpoint}}}));
      else if(provider==='minimax')res.end(JSON.stringify({base_resp:{status_code:0},data:{status:2,audio:wave().toString('hex')}}));
      else if(provider==='tencent')res.end(JSON.stringify({Response:{Audio:pcm.toString('base64')}}));
      else if(provider==='volcengine')res.end(JSON.stringify({code:0,data:pcm.toString('base64')})+'\n'+JSON.stringify({code:20000000}));
      else if(provider==='elevenlabs')res.end(pcm);
      else res.end(wave());
    });
    const cfg={...DEFAULTS,...PRESETS[provider],endpoint,workspaceId:'workspace-fixture'};
    if(provider==='compatible'){cfg.model='test-model';cfg.voice='test-voice';}
    const credentials=provider==='tencent'?{secretId:'test-id',secretKey:'test-secret'}:{apiKey:'test-key'};
    const bytes=await synthesize(cfg,credentials,'你好');
    assert.deepEqual(validateWave(bytes),bytes);
    const body=received.body;
    if(provider==='aliyun')assert.equal(body.input.text,'你好');
    else if(provider==='volcengine')assert.equal(body.req_params.text,'你好');
    else if(provider==='tencent')assert.equal(body.Text,'你好');
    else if(provider==='azure')assert.match(body,/>你好<\/prosody>/);
    else if(['minimax','elevenlabs'].includes(provider))assert.equal(body.text,'你好');
    else assert.equal(body.input,'你好');
  });
}
