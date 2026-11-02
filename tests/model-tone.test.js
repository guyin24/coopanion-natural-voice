import test from 'node:test';
import assert from 'node:assert/strict';
import {NaturalVoiceWorld} from '../src/world.js';
import {DEFAULTS,PRESETS} from '../src/config.js';
import {say,storeWith,until,wave} from './helpers.js';
import {wrapPetWebSocket} from '../src/pet-sync.js';

function fixture(t,overrides={}){
  const cfg={...DEFAULTS,...PRESETS.aliyun,toneMode:'ordinal',model:'qwen-audio-3.1-tts-flash',voice:'anyuqing_v3.1',workspaceId:'tone-fixture',enabled:true,...overrides};
  const store=storeWith(),requests=[],played=[],audioRequests=new WeakMap();
  const world=new NaturalVoiceWorld({cfg,secret:()=> 'fixture-key',storeSecret(){}},{pollMs:60000,
    synthesize:async(config,credentials,text)=>{const request={text,instruction:config.speechInstruction};requests.push(request);const bytes=wave();audioRequests.set(bytes,request);return bytes;},play:async bytes=>{played.push(audioRequests.get(bytes));}});
  t.after(()=>world.stop());
  return {world,store,requests,played,cfg,start:()=>world.start({store,log:{warn(){}}})};
}
const toolOf=world=>world.tools().find(tool=>tool.name==='voice_set_tone');

test('model delivery exposes a bounded annotation tool and environment instructions only for supported enabled models',t=>{
  const s=fixture(t);const tool=toolOf(s.world);assert.ok(tool,'the model needs a declared tone tool');
  assert.equal(tool.parameters.properties.tones.maxItems,5);
  assert.ok(s.world.envPromptVars());
  assert.ok(s.world.webUi().promptDocs.some(doc=>doc.role==='envPrompt'));
  for(const overrides of [{modelTone:false},{provider:'openai'},{model:'cosyvoice-v2'},{autoRead:false}])assert.equal(fixture(t,overrides).world.tools().length,0);
});

test('one model plan supplies independent instructions per beat and never puts tone into spoken text',async t=>{
  const s=fixture(t);await s.start();const tool=toolOf(s.world);assert.ok(tool);
  const a='别着急，慢慢说。',b='太好了，真替你高兴！';
  await tool.handler({lines:[{text:a,tone:'轻声、安慰地说。'},{text:b,tone:'开心、带一点惊喜。'}]},{callId:'tone-one'});
  s.store.add({...say(1,a+b),meta:{kind:'say',beats:[{text:a},{text:b}]}});s.world.poll();
  await until(()=>!s.world.state().busy&&s.requests.length===2);
  assert.equal(s.requests.map(r=>r.text).join(''),a+b);
  assert.equal(s.requests[0].text,a);assert.equal(s.requests[1].text,b);
  assert.match(s.requests[0].instruction,/安慰/);assert.match(s.requests[1].instruction,/惊喜/);
  assert.ok(s.requests.every(r=>!r.text.includes('语气')));
});

test('an aborted or disabled delivery plan cannot leak onto a subsequent same-text reply',async t=>{
  const s=fixture(t);await s.start();const tool=toolOf(s.world);assert.ok(tool);
  await tool.handler({lines:[{text:'欢迎回来。',tone:'兴奋地说。'}]},{callId:'cancel-tone'});s.world.cancel();s.requests.length=0;
  s.store.add(say(1,'欢迎回来。'));s.world.poll();await until(()=>s.requests.length===1&&!s.world.state().busy);
  assert.equal(s.requests[0].instruction,s.cfg.speechInstruction);
});

test('five annotated beats keep their complete context and five different tones',async t=>{
  const s=fixture(t);await s.start();const lines=Array.from({length:5},(_,i)=>({text:`这是第${i+1}句话，保持完整的语调。`,tone:`第${i+1}种语气。`}));
  await toolOf(s.world).handler({lines},{callId:'five-tones'});
  s.store.add({...say(1,''),meta:{kind:'say',beats:lines.map(({text})=>({text}))}});s.world.poll();
  await until(()=>s.requests.length===5&&!s.world.state().busy);
  assert.deepEqual(s.requests.map(r=>r.text),lines.map(l=>l.text));
  for(let i=0;i<5;i++)assert.ok(s.requests[i].instruction.includes(lines[i].tone));
});

test('streamed annotations remain speculative across round end and require their actual handler to confirm',async t=>{
  const s=fixture(t);await s.start();const tap=s.world.outputTap(),args={lines:[{text:'欢迎回来。',tone:'轻松、带一点惊喜。'}]};
  tap.onEvent({type:'response.output_item.added',item:{id:'tone-item',call_id:'tone-call',type:'function_call',name:'voice_set_tone'}});
  tap.onEvent({type:'response.function_call_arguments.delta',item_id:'tone-item',delta:JSON.stringify(args)});
  tap.onEvent({type:'response.function_call_arguments.done',item_id:'tone-item',arguments:JSON.stringify(args)});
  tap.onRoundEnd();assert.equal(s.world.tonePlans.claim('欢迎回来。'),null);
  await toolOf(s.world).handler(args,{callId:'tone-call'});
  s.store.add(say(1,'欢迎回来。'));s.world.poll();await until(()=>s.requests.length===1&&!s.world.state().busy);
  assert.match(s.requests[0].instruction,/惊喜/);
  assert.equal(s.world.tonePlans.pending,0);
});

test('an unexecuted speculative annotation never supplies actual speech delivery',async t=>{
  const s=fixture(t);await s.start();s.world.prewarmTonePlan(s.world.tonePlans.register({lines:[{text:'保持平静。',tone:'兴奋大喊。'}]},'not-executed',false));
  s.store.add(say(1,'保持平静。'));s.world.poll();await until(()=>s.requests.length===1&&!s.world.state().busy);
  assert.equal(s.requests.at(-1).instruction,s.cfg.speechInstruction);
});

test('repeated same-text replies receive FIFO tones without sharing incompatible prewarmed audio',async t=>{
  const s=fixture(t);await s.start();const text='欢迎回来。';
  const played=[];s.world.play=async()=>{played.push(s.world.active);};
  await toolOf(s.world).handler({lines:[{text,tone:'温柔、低声。'},{text,tone:'兴奋、轻快。'}]},{callId:'same-text'});
  s.store.add({...say(1,text),meta:{kind:'say',beats:[{text},{text}]}});s.world.poll();await until(()=>played.length===2&&!s.world.state().busy);
  assert.match(s.requests[0].instruction,/温柔/);assert.match(s.requests[1].instruction,/兴奋/);
});

test('pet_ask receives its matching delivery while question options stay out of synthesis',async t=>{
  const s=fixture(t);await s.start();const question='你愿意慢慢和我说说吗？';
  await toolOf(s.world).handler({lines:[{text:question,tone:'温柔地询问，留出思考的停顿。'}]},{callId:'ask-tone'});
  s.store.add({...say(1,question),meta:{kind:'ask',question,options:['愿意','稍后']}});s.world.poll();await until(()=>s.requests.length===1&&!s.world.state().busy);
  assert.equal(s.requests[0].text,question);assert.match(s.requests[0].instruction,/询问/);
});
test('truncation keeps the annotated tone and speculative synthesis respects the per-reply character budget',async t=>{
  const s=fixture(t,{maxChars:50});await s.start();const text='这是一段较长的测试文字，用于确认限制长度以后仍然保留模型选择的安慰语气。'.repeat(4);
  await toolOf(s.world).handler({lines:[{text,tone:'温柔安慰。'}]},{callId:'bounded-tone'});
  s.store.add(say(1,text));s.world.poll();await until(()=>!s.world.state().busy);
  assert.ok(s.requests.length>0);assert.ok(s.requests.every(r=>Array.from(r.text).length<=57));
  assert.ok(s.requests.every(r=>r.instruction.includes('温柔安慰')));
});
test('mixed annotated and fallback beats preserve all words and all selected tones beyond five physical segments',async t=>{
  const s=fixture(t);await s.start();const a='这句用默认风格，保留两个小段。',lines=Array.from({length:5},(_,i)=>({text:`第${i+1}句，带上独立语气。`,tone:`语气${i+1}。`}));
  await toolOf(s.world).handler({lines},{callId:'mixed-tones'});
  s.store.add({...say(1,''),meta:{kind:'say',beats:[{text:a},...lines.map(({text})=>({text}))]}});s.world.poll();
  await until(()=>!s.world.state().busy);
  assert.equal(s.played.map(r=>r.text).join(''),a+lines.map(l=>l.text).join(''));
  for(const line of lines)assert.ok(s.played.some(r=>r.text===line.text&&r.instruction.includes(line.tone)));
});
test('whole annotated beats release the comma-keyed bubble only when the native playback callback fires',async t=>{
  const s=fixture(t);await s.start();const sent=[],text='别着急，慢慢说。';let options,finish;
  s.world.playReportsStart=true;s.world.play=async(bytes,signal,opts)=>{options=opts;await new Promise(resolve=>{finish=resolve;});};
  const socket=wrapPetWebSocket({send:data=>sent.push(JSON.parse(data))});
  await toolOf(s.world).handler({lines:[{text,tone:'温柔、安慰。'}]},{callId:'bubble-tone'});
  socket.send(JSON.stringify({t:'say',id:'full-beat-bubble',beats:[{text}]}));
  s.store.add(say(1,text));s.world.poll();
  try{await until(()=>options);assert.equal(sent.length,0);options.onStart();assert.equal(sent.length,1);assert.equal(s.world.lastTone,'温柔、安慰。');}
  finally{finish?.();await until(()=>!s.world.state().busy);}
});
test('turn completion removes unspoken model tones before a later identical line',async t=>{
  const s=fixture(t);await s.start();await toolOf(s.world).handler({lines:[{text:'下次见。',tone:'悲伤地说。'}]},{callId:'old-turn'});
  s.world.onTurnEnded();s.requests.length=0;s.store.add(say(1,'下次见。'));s.world.poll();await until(()=>!s.world.state().busy);
  assert.equal(s.played.length,1);assert.equal(s.played[0].instruction,s.cfg.speechInstruction);
});
