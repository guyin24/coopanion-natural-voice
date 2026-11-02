import test from 'node:test';
import assert from 'node:assert/strict';
import {NaturalVoiceWorld} from '../src/world.js';
import {DEFAULTS} from '../src/config.js';
import {wave,until} from './helpers.js';
import {setBubbleSyncGate,wrapPetWebSocket} from '../src/pet-sync.js';

for(const early of [false,true]){
  test(`${early?'early chunk':'whole audio'} waits for native readiness before showing its bubble`,async t=>{
    const cfg={...DEFAULTS,enabled:true},controller=new AbortController(),sent=[];
    let options,finishPlayback;
    const playing=new Promise(resolve=>{finishPlayback=resolve;});
    const world=new NaturalVoiceWorld({cfg,secret:()=>'',storeSecret(){}},{playReportsStart:true,
      synthesize:async()=>wave(),play:(bytes,signal,opts)=>{options=opts;return playing;}});
    world.running=true;world.phase='generating';
    setBubbleSyncGate(()=>({enabled:true,timeoutMs:5000}));
    t.after(async()=>{finishPlayback();controller.abort();setBubbleSyncGate(null);await world.stop();});
    const ws=wrapPetWebSocket({send:data=>sent.push(JSON.parse(data))});
    ws.send(JSON.stringify({t:'say',id:'readiness-test',beats:[{text:'准备好再显示。',actions:[],anchors:[]}]}));
    const audio=wave();
    const task={controller,promise:Promise.resolve(early?null:audio),earlyChunks:early?[audio]:null,waitEarly:early?()=>Promise.resolve():null};
    const running=world.runSynthTask(task,'准备好再显示。',cfg,controller);
    try{
      await until(()=>options);
      assert.equal(sent.length,0,'file preparation must not release the bubble');
      assert.equal(world.phase,'generating');
      assert.equal(typeof options.onStart,'function');
      options.onStart();
      assert.equal(sent.length,1);assert.equal(world.phase,'playing');
    }finally{finishPlayback();await running;}
  });
}
