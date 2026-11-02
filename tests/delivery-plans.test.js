import test from 'node:test';
import assert from 'node:assert/strict';
import {DeliveryPlans,deliveryInstruction} from '../src/delivery.js';
const args=(tone='开心地说。')=>({lines:[{text:'你好呀，欢迎回来。',tone}]});

test('delivery validation is atomic, bounded and omits invalid user payloads from errors',()=>{
  const book=new DeliveryPlans();book.register(args(),'valid');
  for(const value of [{},{lines:[]},{lines:Array(6).fill(args().lines[0])},{lines:[args().lines[0],{text:'SECRET',tone:42}]},{lines:[{text:'',tone:'开心'}]},{lines:[{text:'测'.repeat(1201),tone:'开心'}]},{lines:[{text:'好',tone:'测'.repeat(201)}]}]){
    assert.throws(()=>book.register(value,'bad'),error=>!error.message.includes('SECRET'));assert.equal(book.pending,1);
  }
});
test('confirmed registration is idempotent and does not reset consumed lines',()=>{
  const book=new DeliveryPlans();book.register(args(),'same',false);assert.equal(book.claim('你好呀，欢迎回来。'),null);
  book.register(args(),'same',true);assert.equal(book.claim('你好呀，欢迎回来。'),'开心地说。');
  book.register(args(),'same',true);assert.equal(book.claim('你好呀，欢迎回来。'),null);
  assert.throws(()=>book.register(args('换成愤怒。'),'same'));
});
test('plans expire and the bounded book evicts old plans instead of retaining unlimited output',()=>{
  let now=0;const book=new DeliveryPlans({now:()=>now,ttlMs:100,maxPlans:2});
  book.register(args(),'one');book.register(args(),'two');book.register(args(),'three');assert.equal(book.plans.length,2);
  now=100;assert.equal(book.peek('你好呀，'),null);assert.equal(book.pending,0);
});
test('cancel invalidates completed speculative calls and late handler confirmation cannot revive them',()=>{
  const book=new DeliveryPlans();book.register(args(),'aborted',false);book.clear();
  assert.throws(()=>book.register(args(),'aborted',true),/取消/);assert.equal(book.pending,0);
  book.register(args(),'new-call',true);assert.equal(book.claim('你好呀，欢迎回来。'),'开心地说。');
});
test('full line matching normalizes presentation markdown, and instructions remain within the config limit',()=>{
  const book=new DeliveryPlans();book.register({lines:[{text:'**你好呀**，欢迎回来。',tone:'轻松、自然。'}]},'markdown');
  assert.equal(book.peek('你好呀，'),'轻松、自然。');assert.equal(book.claim('你好呀，欢迎回来。'),'轻松、自然。');
  const instruction=deliveryInstruction('基'.repeat(500),'语'.repeat(200));assert.ok(Array.from(instruction).length<=500);assert.ok(instruction.endsWith('语'.repeat(200)));
});
test('punctuation distinguishes a question from an exclamation when binding exact tone annotations',()=>{
  const book=new DeliveryPlans();book.register({lines:[{text:'真的吗？',tone:'疑惑地询问。'},{text:'真的吗！',tone:'惊喜地感叹。'}]},'punctuation');
  assert.equal(book.find('真的吗！').tone,'惊喜地感叹。');
  assert.equal(book.claim('真的吗！'),'惊喜地感叹。');assert.equal(book.claim('真的吗？'),'疑惑地询问。');
});
