/* Pure, testable notification policy. Content/URL/user text is never included. */
((root) => {
  'use strict';
  const DEFAULTS = Object.freeze({
    notifyCompleted: false,
    notifyAttention: false,
    notifyLongRunning: false,
    longRunningMinutes: 10
  });
  const VALID_MINUTES = Object.freeze([5, 10, 15, 30, 60]);
  const running = (state) => state === 'thinking' || state === 'working';
  const validTimestamp = (value, now = Date.now()) =>
    Number.isSafeInteger(value) && value > 0 && value <= now + 2000 && value > now - 7 * 86400000;
  function settingsFor(data = {}) {
    return {
      notifyCompleted: data.notifyCompleted === true,
      notifyAttention: data.notifyAttention === true,
      notifyLongRunning: data.notifyLongRunning === true,
      longRunningMinutes: VALID_MINUTES.includes(Number(data.longRunningMinutes)) ? Number(data.longRunningMinutes) : 10
    };
  }
  function shouldNotifyCompletion(before, after, now = Date.now()) {
    return !!before && !!after && running(before.state) && before.confirmed === true &&
      after.state === 'idle' && after.completionConfirmed === true &&
      before.mode === after.mode && validTimestamp(before.startedAt, now) &&
      before.startedAt === after.completedRunStartedAt;
  }
  function shouldNotifyAttention(before, after, now = Date.now()) {
    return !!before && after?.mode === 'work' && after.state === 'attention' &&
      before.state !== 'attention' && validTimestamp(after.attentionSince, now);
  }
  function shouldNotifyLong(record, now, minutes) {
    return running(record?.state) && record.confirmed === true &&
      validTimestamp(record.startedAt, now) && now - record.startedAt >= minutes * 60000;
  }
  function elapsed(startedAt, now = Date.now()) {
    if (!validTimestamp(startedAt, now)) return '';
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor(seconds % 3600 / 60);
    const secs = seconds % 60;
    return hours ? `${hours}時間${mins}分` : mins ? `${mins}分${secs}秒` : `${secs}秒`;
  }
  const api = Object.freeze({ DEFAULTS, VALID_MINUTES, settingsFor, validTimestamp,
    running, shouldNotifyCompletion, shouldNotifyAttention, shouldNotifyLong, elapsed });
  root.TabPulseNotifications = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
