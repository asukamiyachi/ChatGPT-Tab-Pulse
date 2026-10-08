const {test} = require('node:test');
const assert = require('node:assert/strict');
const alerts = require('../src/notifications.js');
const now = Date.now();
const start = now - 12 * 60000;
const running = {state:'thinking',mode:'chat',confirmed:true,startedAt:start};
const completed = {state:'idle',mode:'chat',completionConfirmed:true,completedRunStartedAt:start};

test('alerts are opt-in; duration is bounded to supported choices', () => {
  assert.deepEqual(alerts.settingsFor({}), alerts.DEFAULTS);
  assert.equal(alerts.settingsFor({notifyCompleted:true,notifyLongRunning:true,longRunningMinutes:15}).longRunningMinutes,15);
  assert.equal(alerts.settingsFor({longRunningMinutes:1}).longRunningMinutes,10);
});
test('completion requires a real confirmed running -> completed transition and same run id',()=>{
  assert.equal(alerts.shouldNotifyCompletion(running,completed,now), true);
  assert.equal(alerts.shouldNotifyCompletion(null,completed,now),false);
  assert.equal(alerts.shouldNotifyCompletion({...running,confirmed:false},completed,now),false);
  assert.equal(alerts.shouldNotifyCompletion({...running,state:'unknown'},completed,now),false);
  assert.equal(alerts.shouldNotifyCompletion(running,{...completed,completionConfirmed:false},now),false);
  assert.equal(alerts.shouldNotifyCompletion(running,{...completed,completedRunStartedAt:start+1},now),false);
  assert.equal(alerts.shouldNotifyCompletion({...running,mode:'work'},completed,now),false);
  assert.equal(alerts.shouldNotifyCompletion(running,{...completed,state:'unknown'},now),false);
});
test('attention only Work, only entering verified attention',()=>{
  const att = {state:'attention',mode:'work',attentionSince:now-1000};
  assert.equal(alerts.shouldNotifyAttention({state:'working'},att,now),true);
  assert.equal(alerts.shouldNotifyAttention({state:'attention'},att,now),false);
  assert.equal(alerts.shouldNotifyAttention(null,att,now),false);
  assert.equal(alerts.shouldNotifyAttention({state:'thinking'},{...att,mode:'chat'},now),false);
});
test('long runtime only for confirmed active runs over threshold',()=>{
  assert.equal(alerts.shouldNotifyLong(running,now,10),true);
  assert.equal(alerts.shouldNotifyLong(running,now,15),false);
  assert.equal(alerts.shouldNotifyLong({...running,state:'attention'},now,5),false);
  assert.equal(alerts.shouldNotifyLong({...running,confirmed:false},now,5),false);
});
test('elapsed time never returns unverified timestamps',()=>{
  assert.match(alerts.elapsed(start,now),/12分/);
  assert.equal(alerts.elapsed(null,now),'');
  assert.equal(alerts.elapsed('12',now),'');
});
