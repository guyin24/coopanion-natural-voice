import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {setBubbleSyncGate} from '../src/pet-sync.js';

test('removing and reinstalling the bubble gate preserves an HTTP wrapper installed after it',()=>{
  const original=http.Server.prototype.emit;
  let outerCalls=0;
  try{
    setBubbleSyncGate(()=>({enabled:true}));
    const hooked=http.Server.prototype.emit;
    const outer=function(...args){outerCalls++;return hooked.apply(this,args);};
    http.Server.prototype.emit=outer;
    setBubbleSyncGate(null);
    const server=new http.Server();
    assert.doesNotThrow(()=>server.emit('fixture-event'));
    assert.equal(http.Server.prototype.emit,outer);
    setBubbleSyncGate(()=>({enabled:true}));
    assert.doesNotThrow(()=>server.emit('fixture-event'));
    setBubbleSyncGate(null);
    assert.doesNotThrow(()=>server.emit('fixture-event'));
    assert.equal(outerCalls,3);
  }finally{
    setBubbleSyncGate(null);
    http.Server.prototype.emit=original;
  }
});
