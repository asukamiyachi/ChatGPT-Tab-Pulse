/* Pure functions for the popup + background worker. No access to conversation content. */
((root) => {
  'use strict';
  const ALLOWED = new Set(['idle', 'thinking', 'working', 'attention', 'unknown', 'disabled', 'error', 'timeout']);
  const RUNNING = new Set(['thinking', 'working']);
  const priority = { timeout: 0, error: 0, attention: 1, working: 2, thinking: 2, idle: 3, unknown: 4, disabled: 5 };

  function isChatGPT(url) {
    try {
      const value = new URL(url);
      return value.protocol === 'https:' && ['chatgpt.com', 'chat.openai.com'].includes(value.hostname);
    } catch (_) { return false; }
  }
  function safeState(state) { return ALLOWED.has(state) ? state : 'unknown'; }
  function countsFor(tabs) {
    const result = { total: tabs.length, idle: 0, thinking: 0, working: 0, attention: 0, unknown: 0, disabled: 0, error: 0, timeout: 0, running: 0 };
    for (const tab of tabs) result[safeState(tab.state)]++;
    result.running = result.thinking + result.working;
    return result;
  }
  function badgeFor(counts) {
    if (counts.timeout || counts.error) return { text: '!', color: '#BD3434' };
    if (counts.running) return {
      text: counts.running > 99 ? '99+' : String(counts.running),
      color: counts.attention ? '#9348C5' : counts.working && !counts.thinking ? '#2767C7' : '#D9900B'
    };
    if (counts.attention) return { text: '!', color: '#9348C5' };
    return { text: '', color: '#64748B' };
  }
  function sortTabs(tabs) {
    return [...tabs].sort((a, b) => {
      if (a.current !== b.current) return a.current ? -1 : 1;
      const byState = (priority[safeState(a.state)] ?? 5) - (priority[safeState(b.state)] ?? 5);
      return byState || (a.windowId - b.windowId) || (a.index - b.index);
    });
  }
  const api = Object.freeze({ isChatGPT, safeState, countsFor, badgeFor, sortTabs });
  root.TabPulseOverview = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
