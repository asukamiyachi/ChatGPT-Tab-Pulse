const {test} = require('node:test');
const assert = require('node:assert/strict');
const code = require('../src/codex-usage.js');
const now = Date.parse('2026-10-08T06:00:00Z');
const snapshot = (ageMinutes=1) => ({
  schemaVersion: 2, source:'codex-app-server', receivedAt:new Date(now-ageMinutes*60000).toISOString(),
  fiveHour:{usedPercent:32.5,remainingPercent:67.5, windowDurationMins:300,resetsAt:'2026-10-08T09:00:00Z'},
  weekly:{usedPercent:70,remainingPercent:30,windowDurationMins:10080,resetsAt:'2026-10-12T09:00:00Z'},
  bankedResets:{availableCount:0}
});
test('endpoint is fixed HTTPS and does not contain credentials',()=>{
  assert.equal(code.API_ENDPOINT,'https://codex-usage-manager.vercel.app/api/usage');
  assert.equal(code.TOKEN_KEY,'codexReadToken');
});
test('token input must be a single printable ASCII line',()=>{
  assert.equal(code.validToken('a'.repeat(32)),true);
  for (const token of ['','x','abc 123','a'.repeat(20)+'\n','🫧'.repeat(18),'x'.repeat(2100)]) assert.equal(code.validToken(token),false);
});
test('fresh payload keeps percentages and zero banked reset count',()=>{
  const data=code.parseSnapshot(snapshot(),now);
  assert.equal(data.freshness,'fresh');
  assert.equal(data.fiveHour.remaining,67.5);
  assert.equal(data.weekly.remaining,30);
  assert.equal(data.bankedResets,0);
  assert.equal(code.displayPercent(data.fiveHour),'68% 残り');
});
test('freshness 15/30 minute limits use server receipt time',()=>{
  assert.equal(code.parseSnapshot(snapshot(15),now).freshness,'fresh');
  assert.equal(code.parseSnapshot(snapshot(16),now).freshness,'delayed');
  assert.equal(code.parseSnapshot(snapshot(30),now).freshness,'delayed');
  assert.equal(code.parseSnapshot(snapshot(31),now).freshness,'stale');
});
test('unknown limit window remains missing, not zero',()=>{
  const obj=snapshot();obj.fiveHour=null;obj.bankedResets=null;
  const data=code.parseSnapshot(obj,now);
  assert.equal(data.fiveHour,null);
  assert.equal(data.bankedResets,null);
  assert.equal(code.displayPercent(data.fiveHour),'未取得');
});
test('invalid payload and future receive timestamp do not render as valid',()=>{
  assert.equal(code.parseSnapshot({schemaVersion:1},now),null);
  const o=snapshot();o.receivedAt='2030-01-01T00:00:00Z';
  assert.equal(code.parseSnapshot(o,now),null);
  o.receivedAt='bad date';assert.equal(code.parseSnapshot(o,now),null);
});
test('malformed percentages, infinity, and mismatched totals are rejected',()=>{
  for(const value of [-1,101,Infinity,NaN,1e30]){
    const obj=snapshot();obj.fiveHour.remainingPercent=value;
    assert.equal(code.parseSnapshot(obj,now).fiveHour,null);
  }
  const obj=snapshot();obj.weekly.usedPercent=40;
  assert.equal(code.parseSnapshot(obj,now).weekly,null);
});
test('reset formatting distinguishes unknown, passed, and upcoming times',()=>{
  const obj=code.parseSnapshot(snapshot(),now);
  assert.match(code.displayReset(obj.fiveHour,now),/あと 3時間/);
  assert.match(code.displayReset(obj.fiveHour,now+100000000),/更新待ち/);
  assert.match(code.displayReset(null),/未取得/);
});
