(() => {
  'use strict';
  const core = globalThis.TabPulseCodex;
  const $ = (id) => document.getElementById(id);
  let busy = false;
  let connecting = false;
  let controller = null;
  let generation = 0;
  function message(text, level = 'info') {
    $('codex-message').textContent = text;
    $('codex-message').dataset.level = level;
  }
  function showConnected(connected) {
    $('codex-connect-form').hidden = connected;
    $('codex-connected-controls').hidden = !connected;
    $('codex-link-status').textContent = connected ? 'セッション接続中' : '未接続';
  }
  function setBusy(value) {
    busy = value;
    $('codex-connect').disabled = value;
    $('codex-refresh').disabled = value;
    $('codex-disconnect').disabled = value;
  }
  function renderWindow(name, window, stale, now) {
    $(`codex-${name}-value`).textContent = stale ? '参考値（古いデータ）' : core.displayPercent(window);
    $(`codex-${name}-bar`).value = stale ? 0 : window?.remaining ?? 0;
    $(`codex-${name}-bar`).hidden = stale || !window;
    $(`codex-${name}-reset`).textContent = stale ? '同期遅延のため現在値は表示できません' : core.displayReset(window, now);
  }
  function renderSnapshot(data) {
    const now = Date.now();
    const parsed = core.parseSnapshot(data, now);
    if (!parsed) { $('codex-values').hidden = true; message('取得データの形式が不正です。更新を確認してください。', 'error'); return; }
    $('codex-values').hidden = false;
    $('codex-panel').dataset.freshness = parsed.freshness;
    const stale = parsed.freshness === 'stale';
    renderWindow('five', parsed.fiveHour, stale, now);
    renderWindow('weekly', parsed.weekly, stale, now);
    $('codex-banked').textContent = stale ? '参考値（非表示）' : parsed.bankedResets === null ? '未取得' : `${parsed.bankedResets} 回`;
    $('codex-last-sync').textContent = new Intl.DateTimeFormat('ja-JP', {year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(parsed.receivedAt) + `（${parsed.ageMinutes}分前）`;
    if (stale) message('同期が30分以上停止しています。残量は現在値として表示しません。Mac側Collectorを確認してください。', 'delayed');
    else if (parsed.freshness === 'delayed') message('同期が15分以上遅延しています。表示値は直近の取得値です。', 'delayed');
    else if (!parsed.fiveHour && !parsed.weekly) message('接続しましたが、5時間・週間枠の情報はまだ取得できていません。', 'delayed');
    else message('Codex Usage Managerから正常に取得しました。');
  }
  async function getToken() {
    return (await chrome.storage.session.get(core.TOKEN_KEY))[core.TOKEN_KEY] || null;
  }
  async function fetchUsage() {
    if (busy) return;
    const mine = ++generation;
    setBusy(true);
    // The token is never written to a URL, DOM value after connect, log, or content script.
    try {
      if (!(await chrome.permissions.contains({ origins: [core.PERMISSION] }))) {
        $('codex-values').hidden = true;
        message('接続先へのアクセス権がありません。もう一度接続してください。', 'error');
        return;
      }
      const token = await getToken();
      if (!core.validToken(token)) { showConnected(false); $('codex-values').hidden = true; message('トークンを再入力してください。'); return; }
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let response;
      try {
        response = await fetch(core.API_ENDPOINT, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal: controller.signal
        });
      } finally { clearTimeout(timeout); }
      if (mine !== generation) return;
      if (!response.ok) {
        $('codex-values').hidden = true;
        const description = response.status === 401 ? '読み取り専用トークンが無効または期限切れです。' :
          response.status === 404 ? 'まだ使用量データがありません。Mac側の同期を確認してください。' :
          response.status === 503 ? 'Codex Usage Managerが現在利用できません。' : `取得に失敗しました（HTTP ${response.status}）。`;
        message(description, 'error');
        return;
      }
      const data = await response.json();
      if (mine === generation) renderSnapshot(data);
    } catch (_) {
      if (mine === generation) { $('codex-values').hidden = true; message('接続できません。ネットワーク・API・同期状況を確認してください。', 'error'); }
    } finally { controller = null; setBusy(false); }
  }
  $('codex-connect-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || connecting) return;
    const token = $('codex-token').value.trim();
    if (!core.validToken(token)) { message('読み取り専用トークンの形式を確認してください。', 'error'); return; }
    // User gesture must initiate optional host permission prompt.
    connecting = true;
    $('codex-connect').disabled = true;
    try {
      const allowed = await chrome.permissions.request({ origins: [core.PERMISSION] });
      if (!allowed) { message('APIへのアクセスは許可されませんでした。Codex連携は無効のままです。', 'error'); return; }
      await chrome.storage.session.set({ [core.TOKEN_KEY]: token });
      $('codex-token').value = '';
      showConnected(true);
      message('取得中…');
      await fetchUsage();
    } catch (_) { message('接続設定に失敗しました。拡張機能の権限を確認してください。', 'error'); }
    finally { connecting = false; $('codex-connect').disabled = false; }
  });
  $('codex-refresh').addEventListener('click', () => { void fetchUsage(); });
  $('codex-disconnect').addEventListener('click', async () => {
    if (busy) return;
    ++generation;
    controller?.abort();
    setBusy(true);
    try {
      await chrome.storage.session.remove(core.TOKEN_KEY);
      await chrome.permissions.remove({origins: [core.PERMISSION]});
      $('codex-values').hidden = true;
      delete $('codex-panel').dataset.freshness;
      $('codex-token').value = '';
      showConnected(false);
      message('切断しました。トークンをセッションから削除しました。');
    } catch (_) { message('切断に失敗しました。拡張機能の設定を確認してください。', 'error'); }
    finally { setBusy(false); }
  });
  (async () => {
    try {
      const token = await getToken();
      const allowed = await chrome.permissions.contains({origins:[core.PERMISSION]});
      if (core.validToken(token) && allowed) { showConnected(true); await fetchUsage(); }
      else { showConnected(false); if (token && !allowed) message('APIのアクセス権がありません。再接続してください。'); }
    } catch (_) { showConnected(false); message('接続設定を読み取れませんでした。', 'error'); }
  })();
})();
