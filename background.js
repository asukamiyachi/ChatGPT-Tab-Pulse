/* MV3 worker: aggregates status, delivers opt-in alerts, and opens the relevant tab. */
importScripts('src/overview.js', 'src/notifications.js');
const overview = globalThis.TabPulseOverview;
const policy = globalThis.TabPulseNotifications;
const statuses = new Map();
const noticeKeys = new Set();
let generation = 0;
let writeQueue = Promise.resolve();
let badgeQueue = Promise.resolve();

// Session storage survives service-worker suspension but not browser restarts.
const ready = chrome.storage.session.get(['pulseStatusRecords', 'pulseNoticeKeys']).then((saved) => {
  for (const [id, rec] of Object.entries(saved.pulseStatusRecords || {})) {
    if (Number.isSafeInteger(Number(id)) && rec && typeof rec === 'object') {
      statuses.set(Number(id), rec);
      generation = Math.max(generation, Number.isSafeInteger(rec.generation) ? rec.generation : 0);
    }
  }
  for (const key of (saved.pulseNoticeKeys || [])) if (typeof key === 'string') noticeKeys.add(key);
}).catch(() => {});

function saveSession() {
  writeQueue = writeQueue.catch(() => {}).then(() => chrome.storage.session.set({
    pulseStatusRecords: Object.fromEntries(statuses),
    pulseNoticeKeys: [...noticeKeys].slice(-400)
  })).catch((error) => console.warn('Tab Pulse: session storage', error));
  return writeQueue;
}

function recordFrom(payload, previous = null) {
  const state = overview.safeState(payload?.state);
  const mode = payload?.mode === 'work' ? 'work' : 'chat';
  const now = Date.now();
  const startedAt = policy.validTimestamp(payload?.startedAt, now) && policy.running(state) ? payload.startedAt : null;
  return {
    state, mode,
    override: ['auto', 'chat', 'work'].includes(payload?.override) ? payload.override : 'auto',
    startedAt,
    confirmed: !!startedAt && payload?.confirmed === true,
    attentionSince: state === 'attention' && policy.validTimestamp(payload?.attentionSince, now) ? payload.attentionSince : null,
    updatedAt: now,
    generation: ++generation,
    // Retain the run ID for only a verified completion transition.
    completionConfirmed: payload?.completionConfirmed === true,
    completedRunStartedAt: policy.validTimestamp(payload?.completedRunStartedAt, now) ? payload.completedRunStartedAt : null,
    errorKind: payload?.errorKind === 'timeout' || payload?.errorKind === 'network' || payload?.errorKind === 'generation' ? payload.errorKind : null,
    failureRunStartedAt: policy.validTimestamp(payload?.failureRunStartedAt, now) ? payload.failureRunStartedAt : null
  };
}
function tabRecord(tab, payload) {
  const state = overview.safeState(payload?.state);
  return {
    id: tab.id, windowId: tab.windowId, index: tab.index,
    title: tab.title || 'ChatGPT', state,
    mode: payload?.mode === 'work' ? 'work' : 'chat',
    override: payload?.override || 'auto',
    startedAt: policy.running(state) && payload?.confirmed ? payload.startedAt : null,
    errorKind: state === 'timeout' || state === 'error' ? payload?.errorKind : null,
    reason: state === 'timeout' ? '処理のタイムアウト表示を検出しました。状態を確認してください。' :
      state === 'error' ? payload?.errorKind === 'network' ? '通信エラー表示を検出しました。接続状態を確認してください。' : '処理エラー表示を検出しました。内容を確認してください。' : null
  };
}
async function supportedTabs() {
  const tabs = await chrome.tabs.query({url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']});
  return tabs.filter((tab) => Number.isInteger(tab.id) && overview.isChatGPT(tab.url));
}
async function queryTab(tab) {
  if (tab.discarded || tab.status === 'loading') return null;
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tab.id, {type: 'GET_STATUS'}),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); })
    ]);
  } catch (_) { return null; }
  finally { clearTimeout(timer); }
}
function updateBadgeSoon() {
  badgeQueue = badgeQueue.catch(() => {}).then(async () => {
    const tabs = await supportedTabs();
    const ids = new Set(tabs.map((t) => t.id));
    let changed = false;
    for (const id of statuses.keys()) if (!ids.has(id)) { statuses.delete(id); changed = true; }
    if (changed) await saveSession();
    const counts = overview.countsFor(tabs.map((t) => ({state: statuses.get(t.id)?.state || 'unknown'})));
    const badge = overview.badgeFor(counts);
    await Promise.all([
      chrome.action.setBadgeText({text: badge.text}),
      chrome.action.setBadgeBackgroundColor({color: badge.color}),
      chrome.action.setTitle({title: `ChatGPT Tab Pulse — 実行中 ${counts.running} / 確認待ち ${counts.attention} / 全 ${counts.total}`})
    ]);
  }).catch((e) => console.warn('Tab Pulse: badge update', e));
}

async function refreshTabs() {
  await ready;
  const tabs = await supportedTabs();
  const observed = generation;
  const results = await Promise.all(tabs.map(async (tab) => ({tab, data: await queryTab(tab)})));
  // An unsolicited content-script update takes precedence over an older poll.
  for (const {tab, data} of results) {
    const prior = statuses.get(tab.id);
    if (!prior || prior.generation <= observed) {
      const next = recordFrom(data);
      if (!data) next.state = 'unknown';
      statuses.set(tab.id, next);
    }
  }
  const ids = new Set(tabs.map(t => t.id));
  for (const id of statuses.keys()) if (!ids.has(id) && statuses.get(id).generation <= observed) statuses.delete(id);
  await saveSession();
  updateBadgeSoon();
  return tabs.map((tab) => tabRecord(tab, statuses.get(tab.id)));
}

async function showNotice(kind, id, runId, detail) {
  const settings = policy.settingsFor(await chrome.storage.local.get(policy.DEFAULTS));
  if (kind === 'completed' && !settings.notifyCompleted ||
      kind === 'attention' && !settings.notifyAttention ||
      kind === 'long' && !settings.notifyLongRunning ||
      (kind === 'timeout' || kind === 'error') && !settings.notifyFailure) return;
  if (!await chrome.permissions.contains({permissions: ['notifications']})) return;
  const key = `${kind}:${id}:${runId}`;
  if (noticeKeys.has(key)) return;
  noticeKeys.add(key);
  if (noticeKeys.size > 400) noticeKeys.delete(noticeKeys.values().next().value);
  await saveSession(); // De-duplicate across suspended worker restarts, before side effect.
  const templates = {
    completed: ['ChatGPTの応答が完了', 'タブに戻って結果を確認できます。'],
    attention: ['ChatGPT Work が確認待ち', '承認や入力が必要な可能性があります。'],
    long: ['ChatGPTの長時間実行を確認', `${detail}以上実行中です。停止と断定せず状態を確認してください。`],
    timeout: ['ChatGPTのタイムアウト表示を検出', '対象タブでエラーを確認してください。自動再試行はしません。'],
    error: ['ChatGPTの処理エラー表示を検出', detail === 'network' ? '通信状態を確認してください。自動再試行はしません。' : '対象タブでエラーを確認してください。']
  };
  const [title, message] = templates[kind];
  try {
    await chrome.notifications.create(`tabpulse-${kind}-${id}-${runId}`, {
      type: 'basic', iconUrl: chrome.runtime.getURL('icons/extension-128.png'), title, message, priority: 1
    });
  } catch (e) { console.warn('Tab Pulse: notification failed', e); }
}

async function considerNotification(id, before, after) {
  if (policy.shouldNotifyCompletion(before, after)) {
    await showNotice('completed', id, after.completedRunStartedAt);
  }
  if (policy.shouldNotifyAttention(before, after)) {
    await showNotice('attention', id, after.attentionSince);
  }
  if (policy.shouldNotifyFailure(before, after)) {
    await showNotice(after.state, id, after.failureRunStartedAt, after.errorKind);
  }
}
async function checkLongRunning() {
  await ready;
  const settings = policy.settingsFor(await chrome.storage.local.get(policy.DEFAULTS));
  if (!settings.notifyLongRunning || !await chrome.permissions.contains({permissions: ['notifications']})) return;
  const tabs = await supportedTabs();
  const now = Date.now();
  for (const tab of tabs) {
    const rec = statuses.get(tab.id);
    if (!rec || !policy.running(rec.state) || rec.confirmed !== true) continue;
    const minutes = rec.mode === 'work' ? settings.workLongMinutes : settings.chatLongMinutes;
    if (!policy.shouldNotifyLong(rec, now, minutes)) continue;
    // A suspended/discarded tab or lost content script is NOT proof of a running task.
    // Re-query the active UI immediately before notifying.
    const fresh = await queryTab(tab);
    if (!fresh || fresh.state !== rec.state || fresh.confirmed !== true ||
      fresh.startedAt !== rec.startedAt || fresh.mode !== rec.mode) continue;
    await showNotice('long', tab.id, rec.startedAt, `${minutes}分`);
  }
}
async function updateLongAlarm() {
  const settings = policy.settingsFor(await chrome.storage.local.get(policy.DEFAULTS));
  if (settings.notifyLongRunning && await chrome.permissions.contains({permissions: ['notifications']})) {
    await chrome.alarms.create('pulse-long-running', {periodInMinutes: 1});
  } else await chrome.alarms.clear('pulse-long-running');
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type === 'TAB_STATUS_UPDATE' && Number.isInteger(sender.tab?.id) && overview.isChatGPT(sender.tab.url)) {
    void (async () => {
      await ready;
      const id = sender.tab.id;
      const prev = statuses.get(id);
      const next = recordFrom(message);
      statuses.set(id, next);
      await saveSession();
      updateBadgeSoon();
      // If the worker has no baseline for this tab, don't fire a completion notification.
      if (prev) await considerNotification(id, prev, next);
    })().catch((e) => console.warn('Tab Pulse: update', e));
    return false;
  }
  if (message?.type === 'GET_OVERVIEW' && !sender.tab) {
    refreshTabs().then((tabs) => reply({ok:true, tabs, counts:overview.countsFor(tabs)}))
      .catch((e) => reply({ok:false, error:String(e)}));
    return true;
  }
  return false;
});
function onNoticeClick(notificationId) {
  const match = /^tabpulse-(completed|attention|long|error|timeout)-(\d+)-(\d+)$/.exec(notificationId);
  if (!match) return;
  const id = Number(match[2]);
  void chrome.tabs.get(id).then(async (tab) => {
    if (!overview.isChatGPT(tab.url)) return;
    await chrome.tabs.update(id, {active:true});
    await chrome.windows.update(tab.windowId, {focused:true});
    await chrome.notifications.clear(notificationId);
  }).catch(() => {});
}
function registerClickHandler() {
  if (chrome.notifications?.onClicked && !registerClickHandler.done) {
    chrome.notifications.onClicked.addListener(onNoticeClick);
    registerClickHandler.done = true;
  }
}
registerClickHandler();
chrome.permissions.onAdded.addListener((change) => {
  if (change.permissions?.includes('notifications')) { registerClickHandler(); void updateLongAlarm(); }
});
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'pulse-long-running') void checkLongRunning(); });
chrome.tabs.onRemoved.addListener((id) => { void ready.then(() => { statuses.delete(id); void saveSession(); updateBadgeSoon(); }); });
chrome.tabs.onUpdated.addListener((id, changes) => {
  if (changes.url || changes.status === 'loading') void ready.then(() => { statuses.delete(id); void saveSession(); updateBadgeSoon(); });
});
chrome.tabs.onReplaced.addListener(() => { void refreshTabs(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && ['notifyCompleted', 'notifyAttention', 'notifyLongRunning', 'longRunningMinutes', 'chatLongMinutes', 'workLongMinutes', 'notifyFailure'].some(k => changes[k])) {
    void updateLongAlarm();
  }
});
chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.permissions?.includes('notifications')) {
    void chrome.storage.local.set({notifyCompleted:false, notifyAttention:false, notifyLongRunning:false, notifyFailure:false});
    void updateLongAlarm();
  }
});
chrome.runtime.onInstalled.addListener(() => { void refreshTabs(); void updateLongAlarm(); });
chrome.runtime.onStartup.addListener(() => { void refreshTabs(); void updateLongAlarm(); });
void ready.then(() => { void refreshTabs(); void updateLongAlarm(); });
