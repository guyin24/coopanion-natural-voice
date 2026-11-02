import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, PRESETS, PROVIDERS, configGroup, validateConfig, normalizeConfig } from '../src/config.js';
import { credentialName, readCredentials, saveCredentials, credentialsReady, migrateLegacyKey, clearCredentials } from '../src/credentials.js';
import { NaturalVoiceWorld } from '../src/world.js';

function context(config={...DEFAULTS}){
  const secrets=new Map();
  return {cfg:config,secrets,secret:name=>secrets.get(name)??'',storeSecret:(name,value)=>secrets.set(name,value),persist:patch=>Object.assign(config,patch)};
}

test('credentials are stored separately and never reused across platforms',()=>{
  const ctx=context();saveCredentials(ctx,'siliconflow',{apiKey:'silicon-key'});
  assert.equal(credentialsReady(ctx,'siliconflow'),true);
  assert.equal(credentialsReady(ctx,'aliyun'),false);
  saveCredentials(ctx,'aliyun',{apiKey:'ali-key'});
  assert.deepEqual(readCredentials(ctx,'siliconflow'),{apiKey:'silicon-key'});
  assert.deepEqual(readCredentials(ctx,'aliyun'),{apiKey:'ali-key'});
  assert.equal(ctx.secrets.get(credentialName('aliyun','apiKey')),'ali-key');
  assert.equal(JSON.stringify(ctx.cfg).includes('ali-key'),false);
});

test('Tencent requires both secrets and validates before writing any of them',()=>{
  const ctx=context();
  assert.throws(()=>saveCredentials(ctx,'tencent',{secretId:'id-only'}));
  assert.equal(ctx.secrets.size,0);
  saveCredentials(ctx,'tencent',{secretId:'test-id',secretKey:'test-secret'});
  assert.equal(credentialsReady(ctx,'tencent'),true);
  assert.throws(()=>saveCredentials(ctx,'aliyun',{secretKey:'wrong-field'}));
});

test('legacy key migrates only to the matching original protocol and stays cleared',()=>{
  const ctx=context({...DEFAULTS,endpoint:PRESETS.openai.endpoint});
  ctx.secrets.set('CORTICO_NATURAL_VOICE_API_KEY','legacy-key');
  migrateLegacyKey(ctx);
  assert.equal(ctx.cfg.provider,'openai');
  assert.equal(readCredentials(ctx,'openai').apiKey,'legacy-key');
  assert.equal(credentialsReady(ctx,'aliyun'),false);
  clearCredentials(ctx,'openai');migrateLegacyKey(ctx);
  assert.equal(credentialsReady(ctx,'openai'),false);
});

test('platform configuration resolves workspace and voice placeholders, enforcing platform limits',()=>{
  const ali={...DEFAULTS,...PRESETS.aliyun,workspaceId:'workspace-test'};
  assert.match(validateConfig(ali),/^https:\/\/workspace-test\.cn-beijing\.maas\.aliyuncs\.com\//);
  assert.throws(()=>validateConfig({...ali,workspaceId:''}),/Workspace/);
  assert.throws(()=>validateConfig({...ali,speed:3}));
  const eleven={...DEFAULTS,...PRESETS.elevenlabs,voice:'voice-test'};
  assert.match(validateConfig(eleven),/text-to-speech\/voice-test$/);
  assert.throws(()=>validateConfig({...eleven,speed:2}));
  assert.equal(normalizeConfig({endpoint:PRESETS.openai.endpoint,model:'tts-test',voice:'test'}).provider,'openai');
});

test('world state exposes only credential-presence flags and saves credentials for the specified provider',async()=>{
  const ctx=context();const world=new NaturalVoiceWorld(ctx);
  await world.webUi().invoke('voice','saveCredentials',['aliyun',{apiKey:'private-ali-key'}]);
  assert.equal(world.state().credentialStatus.aliyun.apiKey,true);
  assert.equal(world.state().keySet,false);
  assert.equal(JSON.stringify(world.state()).includes('private-ali-key'),false);
  ctx.cfg.provider='aliyun';assert.equal(world.state().keySet,true);
  await world.webUi().invoke('voice','clearCredentials',['aliyun']);
  assert.equal(world.state().keySet,false);
});

test('legacy credentials never migrate into a new provider or a second original provider',()=>{
  const ctx=context({...DEFAULTS,...PRESETS.aliyun});
  ctx.secrets.set('CORTICO_NATURAL_VOICE_API_KEY','legacy-key');
  migrateLegacyKey(ctx);
  assert.equal(credentialsReady(ctx,'aliyun'),false);
  Object.assign(ctx.cfg,PRESETS.siliconflow);migrateLegacyKey(ctx);
  assert.equal(readCredentials(ctx,'siliconflow').apiKey,'legacy-key');
  Object.assign(ctx.cfg,PRESETS.openai);migrateLegacyKey(ctx);
  assert.equal(credentialsReady(ctx,'openai'),false);
});

test('clearing credentials uses host-compatible tombstones and blanks optional fields',()=>{
  const ctx=context();
  ctx.storeSecret=(name,value)=>{assert.ok(value&&!/\s/.test(value));ctx.secrets.set(name,value);};
  saveCredentials(ctx,'tencent',{secretId:'identifier',secretKey:'secret',sessionToken:'temporary'});
  clearCredentials(ctx,'tencent');
  assert.equal(credentialsReady(ctx,'tencent'),false);
  assert.deepEqual(readCredentials(ctx,'tencent'),{secretId:'',secretKey:'',sessionToken:''});
  assert.equal(ctx.secrets.size,3);
});

test('credential validation is atomic and partial updates retain existing required values',()=>{
  const ctx=context();
  assert.throws(()=>saveCredentials(ctx,'tencent',{secretId:'valid-id',secretKey:'bad\nkey'}));
  assert.equal(ctx.secrets.size,0);
  saveCredentials(ctx,'tencent',{secretId:'id',secretKey:'key'});
  saveCredentials(ctx,'tencent',{sessionToken:'token'});
  assert.deepEqual(readCredentials(ctx,'tencent'),{secretId:'id',secretKey:'key',sessionToken:'token'});
  const before=[...ctx.secrets];
  assert.throws(()=>saveCredentials(ctx,'tencent',{secretId:'new-id',wrongField:'bad'}));
  assert.deepEqual([...ctx.secrets],before);
  assert.throws(()=>saveCredentials(ctx,'not-a-provider',{apiKey:'key'}));
});

test('metadata covers all providers and host configuration contains no secret fields',()=>{
  assert.deepEqual(Object.keys(PROVIDERS).sort(),['aliyun','azure','compatible','elevenlabs','minimax','openai','siliconflow','tencent','volcengine']);
  const fields=configGroup().schema.properties;
  for(const field of ['provider','sampleRate','region','workspaceId'])assert.ok(fields[`worlds.natural-voice.${field}`]);
  for(const field of ['apiKey','secretId','secretKey','sessionToken','appId'])assert.equal(fields[`worlds.natural-voice.${field}`],undefined);
  for(const [id,metadata] of Object.entries(PROVIDERS)){
    assert.ok(metadata.label.zh&&metadata.label.en&&metadata.docs.startsWith('https://'));
    assert.ok(metadata.credentials.length&&metadata.sampleRates.includes(PRESETS[id].sampleRate));
  }
});

test('configuration rejects invalid provider settings before making requests',()=>{
  const cfg={...DEFAULTS,...PRESETS.tencent};
  assert.throws(()=>validateConfig({...cfg,sampleRate:48000}));
  assert.throws(()=>validateConfig({...cfg,speed:0.5}));
  assert.throws(()=>validateConfig({...cfg,model:'2'}));
  assert.throws(()=>validateConfig({...cfg,voice:'not-a-number'}));
  assert.throws(()=>validateConfig({...cfg,endpoint:'https://user:password@example.com'}));
  assert.throws(()=>validateConfig({...cfg,endpoint:'https://example.com/?api_key=secret'}));
  assert.throws(()=>validateConfig({...cfg,provider:'missing'}));
  assert.throws(()=>validateConfig({...DEFAULTS,...PRESETS.azure,region:'eastasia.evil/route'}));
  assert.throws(()=>validateConfig({...DEFAULTS,...PRESETS.aliyun,workspaceId:'evil.example/route'}));
  assert.match(validateConfig({...cfg,endpoint:'http://127.0.0.1:1234/tts'}),/^http:\/\/127\.0\.0\.1:1234/);
});
