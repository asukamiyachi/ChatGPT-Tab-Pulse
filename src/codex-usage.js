(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TabPulseCodex = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const API_ORIGIN = 'https://codex-usage-manager.vercel.app/';
  const API_ENDPOINT = API_ORIGIN + 'api/usage';
  const TOKEN_KEY = 'codexReadToken';
  const PERMISSION = 'https://codex-usage-manager.vercel.app/*';
  const MAX_DELAY_MS = 30 * 60 * 1000;
  const FRESH_MS = 15 * 60 * 1000;

  function percent(x) { return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 100 ? x : null; }
  function dateMs(x) { if (typeof x !== 'string' || !x) return null; const n = Date.parse(x); return Number.isFinite(n) ? n : null; }
  function validToken(s) { return typeof s === 'string' && s.length >= 16 && s.length <= 2048 && !/\s/.test(s) && /^[\x21-\x7e]+$/.test(s); }
  function windowUsage(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const remaining = percent(value.remainingPercent);
    const used = percent(value.usedPercent);
    if (remaining === null || used === null || Math.abs(100 - remaining - used) > 1) return null;
    return {
      remaining,
      used,
      resetsAt: dateMs(value.resetsAt),
      duration: Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null
    };
  }
  function parseSnapshot(data, now = Date.now()) {
    if (!data || typeof data !== 'object' || data.schemaVersion !== 2 || data.source !== 'codex-app-server') return null;
    const receivedAt = dateMs(data.receivedAt);
    if (receivedAt === null || receivedAt > now + 5 * 60 * 1000) return null;
    const elapsed = Math.max(0, now - receivedAt);
    const freshness = elapsed <= FRESH_MS ? 'fresh' : elapsed <= MAX_DELAY_MS ? 'delayed' : 'stale';
    const fiveHour = windowUsage(data.fiveHour);
    const weekly = windowUsage(data.weekly);
    const availableCount = data.bankedResets?.availableCount;
    const bankedResets = Number.isSafeInteger(availableCount) && availableCount >= 0 ? availableCount : null;
    return { fiveHour, weekly, bankedResets, receivedAt, freshness, ageMinutes: Math.floor(elapsed / 60000) };
  }
  function displayPercent(window) { return window ? `${Math.round(window.remaining)}% 残り` : '未取得'; }
  function displayReset(window, now = Date.now()) {
    if (!window || window.resetsAt === null) return 'リセット時刻 未取得';
    const time = new Intl.DateTimeFormat('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(window.resetsAt);
    const until = window.resetsAt - now;
    if (until <= 0) return `${time}（リセット時刻経過・更新待ち）`;
    const mins = Math.ceil(until / 60000);
    const days = Math.floor(mins / 1440), hrs = Math.floor(mins % 1440 / 60), min = mins % 60;
    return `${time}（あと ${days ? days+'日 ' : ''}${hrs ? hrs+'時間 ' : ''}${min}分）`;
  }
  return { API_ORIGIN, API_ENDPOINT, TOKEN_KEY, PERMISSION, validToken, parseSnapshot, displayPercent, displayReset };
});
