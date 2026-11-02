import test from 'node:test';
import assert from 'node:assert/strict';
import * as catalog from '../src/catalog.js';
import {serverFor} from './helpers.js';

test('compatible service discovers models before a model or voice ID has been chosen',async t=>{
  let seen=0;
  const endpoint=await serverFor(t,(req,res)=>{seen++;assert.equal(req.url,'/v1/models');res.end('{"data":[{"id":"my-tts-model"}]}');});
  const result=await catalog.discoverCatalog({provider:'compatible',endpoint,model:'',voice:''},{apiKey:'catalog-key'});
  assert.equal(seen,1);
  assert.ok(result.models.some(model=>model.id==='my-tts-model'));
});

test('catalog sanitization bounds entries, deduplicates IDs and removes credential echoes',()=>{
  const result=catalog.sanitizeCatalog({
    models:[{id:'model',label:'name private-key'},{id:'model',label:'duplicate'},{id:'bad\nvalue'},{id:'private-key'}],
    voices:[{id:'voice',label:'Readable voice',models:['model','bad\nvalue','private-key']},null,{id:'x'.repeat(513)}],
    source:'mixed',note:'note private-key',
  },['private-key']);
  assert.equal(result.models.length,1);
  assert.equal(result.models[0].id,'model');
  assert.equal(result.voices.length,1);
  assert.deepEqual(result.voices[0].models,['model']);
  assert.doesNotMatch(JSON.stringify(result),/private-key/);
  const bounded=catalog.sanitizeCatalog({models:Array.from({length:2500},(_,i)=>({id:String(i)})),voices:[]});
  assert.equal(bounded.models.length,2000);
});

test('all built-in providers have readable labeled fallback catalogs without credentials',async()=>{
  for(const provider of ['siliconflow','openai','aliyun','volcengine','tencent','minimax','elevenlabs','azure']){
    const value=await catalog.discoverCatalog({provider},{ });
    assert.equal(value.source,'preset',provider);
    assert.ok(value.models.length,provider);
    assert.ok(value.voices.length,provider);
    assert.ok(value.voices.every(voice=>voice.label&&voice.id));
  }
});

test('custom compatible catalog keeps manual entry usable before endpoint and credentials exist',async()=>{
  const value=await catalog.discoverCatalog({provider:'compatible'},{});
  assert.equal(value.source,'preset');
  assert.ok(value.note);
  assert.ok(Array.isArray(value.models)&&Array.isArray(value.voices));
});
