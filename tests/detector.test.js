const { test } = require('node:test');
const assert = require('node:assert/strict');
const { modeFor, stateFor, reasonFor } = require('../src/detector.js');
const base = { enabled: true, override: 'auto', pathname: '/c/example', composerVisible: true,
  stopVisible: false, workModeSelected: false, workTaskMarker: false, optimisticSend: false,
  workRunningVisible: false, workDoneVisible: false, attentionVisible: false };
const detect = (props = {}) => stateFor({ ...base, ...props });

test('normal Chat: ready when composer exists', () => assert.equal(detect(), 'idle'));
test('normal Chat: stop button means thinking', () => assert.equal(detect({stopVisible:true}), 'thinking'));
test('normal Chat: send optimistic until timeout', () => assert.equal(detect({optimisticSend:true}), 'thinking'));
test('normal Chat: no composer means unknown', () => assert.equal(detect({composerVisible:false}), 'unknown'));
test('Work path selected automatically', () => assert.equal(modeFor({...base, pathname:'/work/tasks'}), 'work'));
test('Work mode selected via UI', () => assert.equal(modeFor({...base,workModeSelected:true}), 'work'));
test('Work task marker selected automatically', () => assert.equal(modeFor({...base,workTaskMarker:true}), 'work'));
test('explicit mode override wins', () => assert.equal(modeFor({...base, override:'chat',pathname:'/work/tasks'}),'chat'));
test('Work: stop button means running', () => assert.equal(detect({override:'work',stopVisible:true}),'working'));
test('Work: running status detected', () => assert.equal(detect({override:'work',workRunningVisible:true}),'working'));
test('Work: attention is distinct from running', () => assert.equal(detect({override:'work',attentionVisible:true}),'attention'));
test('Work: completed status is idle', () => assert.equal(detect({override:'work',workDoneVisible:true}),'idle'));
test('Work: no stop button is NOT completion', () => assert.equal(detect({override:'work'}),'unknown'));
test('Work: approval takes priority over an active stop button', () => assert.equal(detect({override:'work',stopVisible:true,attentionVisible:true}),'attention'));
test('Disabled always disabled', () => assert.equal(detect({enabled:false,stopVisible:true}),'disabled'));
test('Work unknown has diagnostic explanation', () => assert.match(reasonFor({...base,override:'work'},'unknown'), /確認できません/));
