const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isChatGPT, safeState, countsFor, badgeFor, sortTabs } = require('../src/overview.js');

test('supports two ChatGPT domains and https only', () => {
  assert.ok(isChatGPT('https://chatgpt.com/c/test'));
  assert.ok(isChatGPT('https://chat.openai.com/c/test'));
  assert.equal(isChatGPT('https://evil.chatgpt.com/'), false);
  assert.equal(isChatGPT('https://chatgpt.com.evil.test/'), false);
  assert.equal(isChatGPT('http://chatgpt.com/'), false);
  assert.equal(isChatGPT('garbage'), false);
});
test('unknown state values are normalized', () => {
  assert.equal(safeState('thinking'), 'thinking');
  assert.equal(safeState('running'), 'unknown');
  assert.equal(safeState(null), 'unknown');
});
test('counts all tabs; only thinking+working count as active', () => {
  assert.deepEqual(countsFor([{state:'thinking'},{state:'working'},{state:'attention'},
    {state:'idle'},{state:'unknown'},{state:'disabled'},{state:'BOGUS'}]),
  {total:7, idle:1, thinking:1, working:1, attention:1, unknown:2, disabled:1, error:0, timeout:0, running:2});
});
test('badge displays concurrent jobs, not total tabs', () => {
  assert.deepEqual(badgeFor(countsFor([{state:'thinking'},{state:'working'},{state:'idle'}])),
    {text:'2',color:'#D9900B'});
  assert.equal(badgeFor(countsFor([{state:'working'}])).color, '#2767C7');
});
test('attention-only badge uses ! and idle-only badge is blank', () => {
  assert.equal(badgeFor(countsFor([{state:'attention'}])).text, '!');
  assert.equal(badgeFor(countsFor([{state:'unknown'},{state:'idle'}])).text, '');
});
test('badge caps high counts to 99+', () => {
  assert.equal(badgeFor(countsFor(Array.from({length: 120}, () => ({state:'thinking'})))).text,'99+');
});
test('current tab goes first and attention is prioritised', () => {
  const tabs = [
    {id:1, state:'idle',current:false,windowId:2,index:0},
    {id:2, state:'attention',current:false,windowId:1,index:0},
    {id:3, state:'thinking',current:true,windowId:1,index:1},
    {id:4, state:'working',current:false,windowId:1,index:2}
  ];
  assert.deepEqual(sortTabs(tabs).map(t=>t.id),[3,2,4,1]);
  assert.equal(tabs[0].id,1,'sort should not mutate input');
});

test('explicit errors are not running and take badge priority', () => {
  const counts = countsFor([{state:'thinking'},{state:'timeout'},{state:'error'}]);
  assert.equal(counts.running,1);
  assert.equal(counts.timeout,1);
  assert.equal(counts.error,1);
  assert.deepEqual(badgeFor(counts),{text:'!',color:'#BD3434'});
});
