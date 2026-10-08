(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const helpers = globalThis.TabPulseOverview;
  const alerts = globalThis.TabPulseNotifications;
  let lastOverview = null;
  const STATE = {
    thinking: ['Chat 応答中', '···'],
    working: ['Work 実行中', '↻'],
    attention: ['Work 確認待ち', '!'],
    idle: ['待機中', '✓'],
    unknown: ['状態不明', '?'],
    disabled: ['オフ', '−']
  };
  let tabId = null;
  let available = false;
  let refreshing = false;
  let lastListSignature = null;

  function render(data) {
    const status = helpers.safeState(data?.state);
    const [label, symbol] = STATE[status];
    $('state-label').textContent = label;
    $('state-reason').textContent = data?.reason || '状態を確認できません';
    $('state-icon').className = `state-icon ${status}`;
    $('state-icon').textContent = symbol;
    if (document.activeElement !== $('mode')) $('mode').value = data?.override || 'auto';
  }

  function makeTabButton(tab) {
    const state = helpers.safeState(tab.state);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tab-item${tab.current ? ' current' : ''}`;
    button.dataset.tabId = String(tab.id);
    button.dataset.windowId = String(tab.windowId);
    button.setAttribute('aria-label', `${tab.title || 'ChatGPT'}、${STATE[state][0]}。タブを開く`);

    const indicator = document.createElement('span');
    indicator.className = `tab-indicator ${state}`;
    indicator.textContent = STATE[state][1];
    indicator.setAttribute('aria-hidden', 'true');
    button.appendChild(indicator);

    const details = document.createElement('span');
    details.className = 'tab-details';
    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'ChatGPT';
    title.title = tab.title || 'ChatGPT';
    const meta = document.createElement('span');
    meta.className = 'tab-meta';
    meta.textContent = `${STATE[state][0]}${tab.mode === 'work' && state !== 'disabled' ? ' · Work' : ''}`;
    details.append(title, meta);
    if (alerts.running(state) && tab.startedAt) {
      const elapsed = document.createElement('span');
      elapsed.className = 'tab-elapsed';
      elapsed.dataset.startedAt = String(tab.startedAt);
      elapsed.textContent = `経過 ${alerts.elapsed(tab.startedAt)}`;
      details.append(elapsed);
    }
    button.appendChild(details);

    if (tab.current) {
      const current = document.createElement('span');
      current.className = 'tab-pill current-pill';
      current.textContent = '現在';
      button.appendChild(current);
    }
    return button;
  }

  function renderOverview(overview, currentId) {
    if (!overview?.ok || !Array.isArray(overview.tabs)) {
      $('list-status').textContent = '取得エラー';
      // Do not leave previously fetched data on screen when the worker is unreachable.
      $('tab-list').replaceChildren();
      const message = document.createElement('p');
      message.className = 'empty';
      message.textContent = '一覧を取得できません。拡張機能を更新してください。';
      $('tab-list').appendChild(message);
      for (const id of ['count-running', 'count-attention', 'count-idle', 'count-total']) $(id).textContent = '–';
      lastListSignature = null;
      lastOverview = null;
      return;
    }
    const tabs = helpers.sortTabs(overview.tabs.map((tab) => ({ ...tab, current: tab.id === currentId })));
    lastOverview = overview;
    const counts = helpers.countsFor(tabs);
    $('count-running').textContent = String(counts.running);
    $('count-attention').textContent = String(counts.attention);
    $('count-idle').textContent = String(counts.idle);
    $('count-total').textContent = String(counts.total);
    $('list-status').textContent = `${counts.total} 件`;

    const signature = JSON.stringify(tabs.map((tab) => [tab.id, tab.windowId, tab.index, tab.title, tab.state, tab.mode, tab.startedAt, tab.current]));
    if (signature === lastListSignature) return;
    lastListSignature = signature;
    if (!tabs.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'ChatGPTのタブがありません。\nchatgpt.com を開くと表示されます。';
      $('tab-list').replaceChildren(empty);
    } else {
      $('tab-list').replaceChildren(...tabs.map(makeTabButton));
    }
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
      tabId = active?.id ?? null;
      available = !!active && helpers.isChatGPT(active.url);
      $('domain-note').hidden = available;
      $('mode').disabled = !available;
      const [overview, current] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'GET_OVERVIEW' }).catch(() => null),
        available ? chrome.tabs.sendMessage(tabId, { type: 'GET_STATUS' }).catch(() => null) : Promise.resolve(null)
      ]);
      renderOverview(overview, tabId);
      render(available
        ? current || { state: 'unknown', reason: 'このタブを再読み込みすると検出が開始します' }
        : { state: 'unknown', reason: '一覧からChatGPTタブに切り替えてください', override: 'auto' });
    } catch (_) {
      render({ state: 'unknown', reason: '状態の取得に失敗しました', override: 'auto' });
      renderOverview(null, tabId);
    } finally { refreshing = false; }
  }

  $('tab-list').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-tab-id]');
    if (!button) return;
    const selectedId = Number(button.dataset.tabId);
    const windowId = Number(button.dataset.windowId);
    try {
      await chrome.tabs.update(selectedId, { active: true });
      await chrome.windows.update(windowId, { focused: true });
      window.close();
    } catch (_) { await refresh(); }
  });

  $('enabled').addEventListener('change', async () => {
    await chrome.storage.local.set({ enabled: $('enabled').checked });
    await refresh();
  });
  $('mode').addEventListener('change', async () => {
    if (!available || tabId === null) return;
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'SET_MODE', mode: $('mode').value });
      render(response);
      await refresh();
    } catch (_) { await refresh(); }
  });
  function updateElapsed() {
    for (const node of document.querySelectorAll('.tab-elapsed')) {
      const startedAt = Number(node.dataset.startedAt);
      node.textContent = `経過 ${alerts.elapsed(startedAt)}`;
    }
  }
  async function readAlertSettings() {
    const settings = alerts.settingsFor(await chrome.storage.local.get(alerts.DEFAULTS));
    for (const key of ['notifyCompleted', 'notifyAttention', 'notifyLongRunning']) $(key).checked = settings[key];
    $('longRunningMinutes').value = String(settings.longRunningMinutes);
    $('longRunningMinutes').disabled = !settings.notifyLongRunning;
  }
  async function changeNotice(key) {
    const enabled = $(key).checked;
    try {
      if (enabled) {
        // Permission prompt happens inside the direct click/change event, not a page-load effect.
        const granted = await chrome.permissions.request({permissions: ['notifications']});
        if (!granted) {
          $('notification-status').textContent = '通知が許可されませんでした。Chromeの拡張機能設定を確認してください。';
          await readAlertSettings();
          return;
        }
      }
      await chrome.storage.local.set({[key]: enabled});
      if (!enabled) {
        const saved = alerts.settingsFor(await chrome.storage.local.get(alerts.DEFAULTS));
        if (!saved.notifyCompleted && !saved.notifyAttention && !saved.notifyLongRunning) {
          await chrome.permissions.remove({permissions: ['notifications']});
        }
      }
      $('notification-status').textContent = enabled ? '通知を有効にしました。' : '通知を無効にしました。';
      await readAlertSettings();
    } catch (_) {
      $('notification-status').textContent = '設定できませんでした。拡張機能の権限を確認してください。';
      await readAlertSettings();
    }
  }
  for (const key of ['notifyCompleted','notifyAttention','notifyLongRunning']) {
    $(key).addEventListener('change', () => { void changeNotice(key); });
  }
  $('longRunningMinutes').addEventListener('change', async () => {
    await chrome.storage.local.set({longRunningMinutes: Number($('longRunningMinutes').value)});
  });
  chrome.storage.local.get({ enabled: true }).then((settings) => {
    $('enabled').checked = settings.enabled !== false;
  });
  void readAlertSettings();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) $('enabled').checked = changes.enabled.newValue !== false;
    if (area === 'local' && ['notifyCompleted','notifyAttention','notifyLongRunning','longRunningMinutes'].some(k => changes[k])) void readAlertSettings();
  });
  refresh();
  setInterval(refresh, 3000);
  setInterval(updateElapsed, 1000);
})();
