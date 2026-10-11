const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname,'..');

function setup() {
  const events = {};
  const mkEvent = (key) => ({ addListener(fn) { events[key] = fn; } });
  const tabs = [
    {id:1, windowId:1,index:0,title:'Chat A',url:'https://chatgpt.com/c/a',status:'complete'},
    {id:2, windowId:1,index:1,title:'Chat B',url:'https://chatgpt.com/c/b',status:'complete'},
    {id:3, windowId:2,index:0,title:'Another site',url:'https://example.org',status:'complete'},
  ];
  const status = new Map([[1,{state:'idle',mode:'chat',override:'auto'}],[2,{state:'thinking',mode:'chat',override:'auto'}]]);
  const action = {text:'',color:null,title:''};
  const shown = [];
  const persistent = {};
  const settings = {notifyCompleted:false,notifyAttention:false,notifyLongRunning:false,longRunningMinutes:10};
  let hasPermission = true;

  const chrome = {
    tabs: {
      get: async (id) => tabs.find(t=>t.id===id),
      update: async (id, props) => { const t=tabs.find(t=>t.id===id); if(t)Object.assign(t,props); },
      query: async (q) => q.url ? tabs.filter(t=> /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(t.url)) : tabs,
      sendMessage: async (id) => status.get(id) || null,
      onRemoved: mkEvent('removed'),
      onUpdated: mkEvent('updated'),
      onReplaced: mkEvent('replaced')
    },
    runtime: {
      onInstalled: mkEvent('installed'),
      onStartup: mkEvent('startup'),
      onMessage: mkEvent('message'),
      getURL: (p) => 'chrome-extension://test/'+p
    },
    storage: {
      session: {get: async () => ({...persistent}), set: async (x) => Object.assign(persistent,x)},
      local: {get: async (defaults) => ({...defaults,...settings}), set: async (x) => Object.assign(settings,x)},
      onChanged: mkEvent('storage')
    },
    permissions: {contains: async () => hasPermission, onRemoved: mkEvent('permissionRemoved'),onAdded: mkEvent('permissionAdded')},
    alarms: {create: async () => {},clear: async () => {},onAlarm: mkEvent('alarm')},
    notifications: {create: async (id, data) => {shown.push({id,data});return id;},clear: async()=>{},onClicked:mkEvent('clicked')},
    windows: {update: async ()=>{}},
    action: {
      setBadgeText: async ({text}) => {action.text=text;},
      setBadgeBackgroundColor: async ({color}) => {action.color=color;},
      setTitle: async ({title}) => {action.title=title;}
    }
  };
  const context = vm.createContext({ chrome, console, setTimeout, clearTimeout, URL, importScripts(...files) {
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file});
  }});
  vm.runInContext(fs.readFileSync(path.join(root,'background.js'),'utf8'),context,{filename:'background.js'});
  const overview = () => new Promise((resolve) => {
    const keep = events.message({type:'GET_OVERVIEW'},{},resolve);
    assert.equal(keep,true);
  });
  const broadcast = (id, stateName, mode='chat', evidence={}) => events.message(
    {type:'TAB_STATUS_UPDATE',state:stateName,mode,override:'auto',...evidence},
    {tab:tabs.find(t=>t.id===id)},()=>{});
  return {events, tabs, status, action, overview, broadcast, shown, settings, persistent,
    allowNotifications(v) { hasPermission = v; }};
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

test('background overview ignores unrelated pages and counts two matching tabs',async()=>{
  const mock = setup();
  const result = await mock.overview();
  assert.equal(result.ok,true);
  assert.deepEqual(result.tabs.map(t=>t.id),[1,2]);
  assert.equal(result.counts.running,1);
  await sleep(220);
  assert.equal(mock.action.text,'1');
});

test('content state change updates badge without popup being opened',async()=>{
  const mock = setup();
  await mock.overview();
  mock.status.set(1,{state:'working',mode:'work'});
  mock.broadcast(1,'working','work');
  await sleep(240);
  assert.equal(mock.action.text,'2');
  assert.match(mock.action.title,/実行中 2/);
});

test('closing a running tab removes it from badge and list',async()=>{
  const mock = setup();
  await mock.overview();
  mock.tabs.splice(mock.tabs.findIndex(t=>t.id===2),1);
  mock.events.removed(2);
  await sleep(220);
  assert.equal(mock.action.text,'');
  assert.equal((await mock.overview()).counts.total,1);
});

test('navigating a tab away from ChatGPT clears stale running count',async()=>{
  const mock = setup();
  await mock.overview();
  mock.tabs[1].url='https://example.org/';
  mock.events.updated(2,{url:'https://example.org/'},mock.tabs[1]);
  await sleep(220);
  assert.equal(mock.action.text,'');
});

test('attention without running changes badge to !',async()=>{
  const mock = setup();
  mock.status.set(2,{state:'attention',mode:'work'});
  await mock.overview();
  await sleep(220);
  assert.equal(mock.action.text,'!');
  assert.equal(mock.action.color,'#9348C5');
});

test('worker reports unknown when a tab content script is unreachable', async()=>{
  const mock = setup();
  mock.status.delete(2);
  const overview = await mock.overview();
  assert.equal(overview.tabs.find(t=>t.id===2).state,'unknown');
  assert.equal(overview.counts.running,0);
});

test('confirmed response completion notifies exactly once and opens the specific tab',async()=>{
  const m=setup();
  m.settings.notifyCompleted=true;
  await m.overview();
  const start=Date.now()-4000;
  m.broadcast(2,'thinking','chat',{startedAt:start,confirmed:true});
  await sleep(40);
  m.broadcast(2,'idle','chat',{completionConfirmed:true,completedRunStartedAt:start});
  await sleep(80);
  assert.equal(m.shown.length,1);
  assert.match(m.shown[0].data.title,/完了/);
  m.broadcast(2,'idle','chat',{completionConfirmed:true,completedRunStartedAt:start});
  await sleep(80);
  assert.equal(m.shown.length,1);
  m.events.clicked(m.shown[0].id);
  await sleep(35);
  assert.equal(m.tabs[1].active,true);
});

test('unverified idle transition and disabled notification settings emit no completion alert',async()=>{
  const m=setup();
  await m.overview();
  const start=Date.now()-5000;
  m.broadcast(2,'thinking','chat',{startedAt:start,confirmed:true});
  await sleep(40);
  m.broadcast(2,'idle','chat',{completionConfirmed:true,completedRunStartedAt:start});
  await sleep(60);
  assert.equal(m.shown.length,0);
  m.settings.notifyCompleted=true;
  m.broadcast(2,'thinking','chat',{startedAt:start+100,confirmed:false});
  await sleep(40);
  m.broadcast(2,'idle','chat',{completionConfirmed:true,completedRunStartedAt:start+100});
  await sleep(60);
  assert.equal(m.shown.length,0);
});

test('Work attention alert only once, not when status was already attention',async()=>{
  const m=setup();
  m.settings.notifyAttention=true;
  await m.overview();
  const time=Date.now()-1100;
  m.broadcast(2,'working','work',{confirmed:true,startedAt:time});
  await sleep(40);
  m.broadcast(2,'attention','work',{attentionSince:time});
  await sleep(80);
  assert.equal(m.shown.length,1);
  m.broadcast(2,'attention','work',{attentionSince:time});
  await sleep(60);
  assert.equal(m.shown.length,1);
});

test('long-running alarm emits one alert per run and respects current tab list', async()=>{
  const m=setup();
  m.settings.notifyLongRunning=true;
  m.settings.chatLongMinutes=5;
  await m.overview();
  const start=Date.now()-360000;
  m.status.set(2,{state:'thinking',mode:'chat',confirmed:true,startedAt:start});
  m.broadcast(2,'thinking','chat',{confirmed:true,startedAt:start});
  await sleep(40);
  m.events.alarm({name:'pulse-long-running'});
  await sleep(90);
  m.events.alarm({name:'pulse-long-running'});
  await sleep(90);
  assert.equal(m.shown.length,1);
  assert.match(m.shown[0].data.title,/長時間/);
});

test('verified timeout notifies once and suppresses completion', async()=>{
  const m=setup();
  m.settings.notifyFailure=true;
  m.settings.notifyCompleted=true;
  await m.overview();
  const run=Date.now()-8000;
  m.broadcast(2,'thinking','chat',{confirmed:true,startedAt:run});
  await sleep(45);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(90);
  assert.equal(m.shown.length,1);
  assert.match(m.shown[0].data.title,/タイムアウト/);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(55);
  assert.equal(m.shown.length,1);
  m.broadcast(2,'idle','chat',{completionConfirmed:false,completedRunStartedAt:run});
  await sleep(55);
  assert.equal(m.shown.length,1);
  m.events.clicked(m.shown[0].id);
  await sleep(35);
  assert.equal(m.tabs[1].active,true);
});

test('no alert for error without baseline, mismatched run or disabled opt-in', async()=>{
  const m=setup();
  m.settings.notifyFailure=true;
  await m.overview();
  const run=Date.now()-7000;
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(50);
  assert.equal(m.shown.length,0);
  m.broadcast(2,'thinking','chat',{confirmed:true,startedAt:run});
  await sleep(35);
  m.broadcast(2,'error','chat',{errorKind:'network',failureRunStartedAt:run+123});
  await sleep(50);
  assert.equal(m.shown.length,0);
  m.broadcast(2,'thinking','chat',{confirmed:true,startedAt:run+500});
  await sleep(35);
  m.settings.notifyFailure=false;
  m.broadcast(2,'error','chat',{errorKind:'generation',failureRunStartedAt:run+500});
  await sleep(50);
  assert.equal(m.shown.length,0);
});

test('long running does not alert without live confirmation',async()=>{
  const m=setup();
  m.settings.notifyLongRunning=true;
  m.settings.chatLongMinutes=5;
  await m.overview();
  const start=Date.now()-500000;
  m.status.set(2,{state:'unknown',mode:'chat'});
  m.broadcast(2,'thinking','chat',{startedAt:start,confirmed:true});
  await sleep(40);
  m.events.alarm({name:'pulse-long-running'});
  await sleep(70);
  assert.equal(m.shown.length,0);
});


test('late timeout after idle sends exactly one notice for same run',async()=>{
  const m=setup();
  m.settings.notifyFailure=true;
  await m.overview();
  const run=Date.now()-7000;
  m.broadcast(2,'thinking','chat',{confirmed:true,startedAt:run});
  await sleep(40);
  m.broadcast(2,'idle','chat',{recentRunStartedAt:run,recentRunObservedAt:Date.now()-1700});
  await sleep(40);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(60);
  assert.equal(m.shown.length,1);
  assert.match(m.shown[0].data.title,/タイムアウト/);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(50);
  assert.equal(m.shown.length,1);
});

test('late timeout from expired or different run cannot notify',async()=>{
  const m=setup();
  m.settings.notifyFailure=true;
  await m.overview();
  const run=Date.now()-120000;
  m.broadcast(2,'idle','chat',{recentRunStartedAt:run,recentRunObservedAt:Date.now()-95000});
  await sleep(40);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(45);
  assert.equal(m.shown.length,0);
  const newRun=Date.now()-4000;
  m.broadcast(2,'idle','chat',{recentRunStartedAt:newRun,recentRunObservedAt:Date.now()-500});
  await sleep(40);
  m.broadcast(2,'timeout','chat',{errorKind:'timeout',failureRunStartedAt:run});
  await sleep(45);
  assert.equal(m.shown.length,0);
});
