import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConfig,validateConfig,configGroup} from '../src/config.js';

test('speaking style has a conversational default and preserves an intentional empty instruction',()=>{
  const cfg=normalizeConfig({provider:'aliyun',model:'qwen-audio-3.1-tts-flash'});
  assert.equal(typeof cfg.speechInstruction,'string');assert.match(cfg.speechInstruction,/自然/);
  assert.equal(normalizeConfig({...cfg,speechInstruction:''}).speechInstruction,'');
  assert.equal(normalizeConfig({...cfg,speechInstruction:' 温柔、安慰的语气。 '}).speechInstruction,'温柔、安慰的语气。');
});

test('speaking style validates type and bounded length without including user text in errors',()=>{
  const cfg=normalizeConfig({provider:'aliyun',workspaceId:'style-test',model:'qwen-audio-3.1-tts-flash',voice:'anyuqing_v3.1'});
  for(const speechInstruction of [null,42,{},'测'.repeat(501)])assert.throws(()=>validateConfig({...cfg,speechInstruction}),/说话风格/);
  assert.doesNotThrow(()=>validateConfig({...cfg,speechInstruction:'测'.repeat(500)}));
  assert.doesNotThrow(()=>validateConfig({...cfg,speechInstruction:''}));
  const field=configGroup().schema.properties['worlds.natural-voice.speechInstruction'];
  assert.equal(field.type,'string');assert.equal(field.maxLength,500);
});
