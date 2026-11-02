import test from 'node:test';
import assert from 'node:assert/strict';
import client from '../web/client.js';
import {PROVIDERS,PRESETS,normalizeConfig} from '../src/config.js';

test('clearing credentials retains the clicked provider during asynchronous RPC work',async()=>{
  const nodes=[];
  class Element{
    constructor(tag,css,content){this.tag=tag;this.children=[];this.listeners={};this.value='';this.type=tag==='input'?'text':'';this.textContent=content??'';this.classList={add(){}};nodes.push(this);}
    append(...children){this.children.push(...children);}
    setAttribute(){} replaceWith(){}
    replaceChildren(...children){this.children=children;}
    addEventListener(type,listener){this.listeners[type]=listener;}
    querySelectorAll(){return nodes.filter(node=>['input','select','button'].includes(node.tag));}
  }
  const state={config:normalizeConfig({provider:'siliconflow'}),providers:PROVIDERS,presets:PRESETS,credentialStatus:{},running:true,keySet:true,phase:'idle'};
  let finishStop,finishClear;
  const stopped=new Promise(resolve=>{finishStop=resolve;}),clearedReply=new Promise(resolve=>{finishClear=resolve;});
  const cleared=[];
  const ctx={language:'zh',signal:new AbortController().signal,ui:{h:(...args)=>new Element(...args)},root:new Element('root'),interval(){},
    async invoke(method,args){
      if(method==='state')return state;
      if(method==='catalog')return {models:[],voices:[],source:'preset'};
      if(method==='stop')return stopped;
      if(method==='clearCredentials'){cleared.push(args[0]);return clearedReply;}
      throw new Error('Unexpected fixture method '+method);
    },
  };
  await client.panels.voice.mount(ctx);
  const provider=nodes.find(node=>node.name==='provider'),clear=nodes.find(node=>node.textContent==='清除此平台凭据');
  clear.listeners.click();
  const locked=provider.disabled;
  if(!locked){provider.value='openai';provider.listeners.change();}
  finishStop(state);await new Promise(resolve=>setImmediate(resolve));
  finishClear(state);await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(cleared,['siliconflow']);
  assert.equal(locked,true);
  assert.equal(provider.disabled,false);
});
