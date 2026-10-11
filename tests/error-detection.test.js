const {test}=require('node:test');
const assert=require('node:assert/strict');
const {classify}=require('../src/error-detection.js');

test('strict explicit timeout, network, and generation failures',()=>{
  assert.equal(classify('Request timed out'),'timeout');
  assert.equal(classify('タイムアウトしました'),'timeout');
  assert.equal(classify('A network error occurred'),'network');
  assert.equal(classify('There was an error generating a response'),'generation');
  assert.equal(classify('Task failed'),'generation');
});
test('rejects long, quoted, and unrelated text to avoid false positives',()=>{
  for(const s of ['','I got a timeout yesterday','Here is a timeout in your code','Timeout handling guide','Request timed out - an example','A network error occurred in my story','Something went wrong for user 123','Timeout '.repeat(45)]){
    assert.equal(classify(s),null,s);
  }
});
