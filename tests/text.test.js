import test from 'node:test';
import assert from 'node:assert/strict';
import { spokenText } from '../src/text.js';
import { say } from './helpers.js';

test('reads displayed beats and questions, excluding activity and other sources', () => {
  const e = say(1, 'fallback');
  e.meta.beats = [{ text: '你好，' }, { text: '今天怎么样？', mood: { zh: '开心' } }];
  assert.equal(spokenText(e, 1200), '你好，今天怎么样？');
  assert.equal(spokenText({ ...e, meta: { kind: 'ask', question: '喝水了吗？', options: ['是', '否'] } }, 1200), '喝水了吗？');
  for (const other of [ { ...e, source: 'other' }, { ...e, type: 'desktop-pet.message' },
    { ...e, meta: { kind: 'activity' } }, { ...e, meta: { kind: 'say', beats: [] } } ]) {
    assert.equal(spokenText(other, 1200), '');
  }
});

test('omits code and image markup, preserves link labels, caps Unicode characters', () => {
  assert.equal(spokenText(say(1, '**你好**，[帮助](https://example.test)。\n```js\nsecret()\n```\n![图片](x)'), 1200), '你好，帮助。');
  assert.equal(spokenText(say(1, '🐳'.repeat(100)), 50), '🐳'.repeat(50) + '。后文省略。');
});
