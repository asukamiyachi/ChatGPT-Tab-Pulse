(function () {
  "use strict";

  const detector = globalThis.ChatGPTStatusDetector;
  const errors = globalThis.TabPulseErrorDetection;
  const SESSION_KEY = "chatgpt-tab-pulse:mode";
  const ICONS = Object.freeze({
    idle: chrome.runtime.getURL("icons/idle-32.png"),
    thinking: chrome.runtime.getURL("icons/thinking-32.png"),
    working: chrome.runtime.getURL("icons/working-32.png"),
    attention: chrome.runtime.getURL("icons/attention-32.png"),
    unknown: chrome.runtime.getURL("icons/unknown-32.png"),
    error: chrome.runtime.getURL("icons/error-32.png"),
    timeout: chrome.runtime.getURL("icons/timeout-32.png")
  });
  let enabled = true;
  let override = readOverride();
  let current = null;
  let queued = false;
  let optimisticUntil = 0;
  let lastPath = location.pathname;
  let lastUrl = location.href;
  let managedIcon = null;
  let lastBroadcast = null;
  let pendingIdleSince = 0;
  let pendingAttentionSince = 0;
  let pendingFailureSince = 0;
  let pendingFailureKind = null;
  let lastRunningEvidenceAt = 0;
  let lastErrorNode = null;
  let lastErrorSeenAt = 0;
  let attentionSince = null;
  const STABLE_IDLE_MS = 1400;
  const STABLE_ATTENTION_MS = 850;
  const STABLE_FAILURE_MS = 1100;
  const FAILURE_GRACE_MS = 90000;
  const previousIcons = new Map();

  function readOverride() {
    try {
      const value = sessionStorage.getItem(SESSION_KEY);
      return value === "work" || value === "chat" ? value : "auto";
    } catch (_) { return "auto"; }
  }
  function writeOverride(value) {
    override = detector.MODES.includes(value) ? value : "auto";
    try {
      if (override === "auto") sessionStorage.removeItem(SESSION_KEY);
      else sessionStorage.setItem(SESSION_KEY, override);
    } catch (_) { /* Storage may be unavailable; in-memory override still works. */ }
  }

  function visible(el) {
    if (!el || !el.isConnected || el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function anyVisible(selectors, base = document) {
    return [...base.querySelectorAll(selectors)].some(visible);
  }

  function normalized(str) {
    return (str || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  const STOP_TEXT = /^(stop|stop generating|stop response|stop thinking|cancel response|停止|生成を停止|応答を停止|思考を停止|回答を停止|中断)$/i;
  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    '[data-testid="stop-generating-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop response"]',
    'button[aria-label="Stop thinking"]',
    'button[aria-label="Stop"]',
    'button[aria-label="停止"]',
    'button[aria-label="生成を停止"]'
  ].join(",");

  function hasStopButton(main) {
    if (anyVisible(STOP_SELECTORS, main)) return true;
    const composer = document.querySelector('form[data-chatgpt-composer], form[class*="composer"], [data-testid="composer"]');
    // Exact text/aria-label matching on buttons, not conversation text.
    const scope = composer || main;
    return [...scope.querySelectorAll('button[aria-label],button[title],button')]
      .some((button) => visible(button) && [button.getAttribute('aria-label'), button.title, button.textContent]
        .some((v) => STOP_TEXT.test(normalized(v))));
  }

  function selectedWorkMode(main) {
    const controls = main.querySelectorAll(
      '[aria-pressed="true"], [aria-selected="true"], [data-state="active"], [data-state="checked"]'
    );
    for (const el of controls) {
      if (!visible(el)) continue;
      const label = normalized(el.getAttribute('aria-label') || el.textContent);
      if (/^(work|ワーク|作業|agent|エージェント)( mode|モード)?$/.test(label)) return true;
    }
    return false;
  }

  const ACTIVE_TEXT = /^(working|working\.\.\.|running|running\.\.\.|in progress|processing|analyzing|researching|作業中|進行中|実行中|処理中|調査中|分析中|推論中)([\s.。…·]*)$/i;
  const DONE_TEXT = /^(completed|task completed|finished|all done|完了|タスク完了|作業完了|実行完了)[\s.!。！]*$/i;
  const ATTENTION_TEXT = /^(approval required|awaiting approval|waiting for approval|needs your input|needs confirmation|action required|確認待ち|承認待ち|入力待ち|操作が必要|確認が必要)[\s.!。！]*$/i;

  function statusVisible(main, pattern) {
    // Limit to live status elements; do not scan previous messages/conversation text.
    const selectors = '[role="status"], [role="alert"], [data-work-status], [data-task-status], [data-testid*="task-status"], [data-testid*="work-status"]';
    for (const el of main.querySelectorAll(selectors)) {
      if (!visible(el)) continue;
      const direct = el.getAttribute('data-work-status') || el.getAttribute('data-task-status');
      const content = normalized(direct || el.textContent);
      if (content.length <= 100 && pattern.test(content)) return true;
    }
    return false;
  }

  function currentErrorKind(main) {
    // Never read message text, generic conversation cards, or historical task logs.
    // Errors must appear in currently visible live alert/status UI.
    const selectors = '[role="alert"], [role="alertdialog"], [data-testid="error-message"], [data-testid="response-error"], [data-testid="task-error"], [data-task-status], [data-work-status]';
    for (const element of main.querySelectorAll(selectors)) {
      if (!visible(element)) continue;
      const raw = element.getAttribute('data-task-status') || element.getAttribute('data-work-status') || element.textContent;
      const kind = errors.classify(raw);
      if (kind) return {kind, node: element};
    }
    return null;
  }

  function attentionControlVisible(main) {
    // Work only. The action controls must be in dialogs/alerts/task panels,
    // not in old message cards or text generated by the assistant.
    const containers = main.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="task-action"], [data-testid*="work-action"]');
    const labels = /^(approve|confirm|take over|sign in|review and approve|承認|確認する|引き継ぐ|ログインする)$/i;
    for (const container of containers) {
      if (!visible(container)) continue;
      for (const btn of container.querySelectorAll('button')) {
        if (visible(btn) && labels.test(normalized(btn.getAttribute('aria-label') || btn.textContent))) return true;
      }
    }
    return false;
  }

  function getSignals() {
    const main = document.querySelector('main') || document.body;
    const path = location.pathname;
    const composerVisible = anyVisible(
      'form[data-chatgpt-composer] textarea, [data-testid="composer"] textarea, #prompt-textarea, [contenteditable="true"][data-testid*="composer"], [contenteditable="true"]#prompt-textarea',
      main
    ) || anyVisible('form[data-chatgpt-composer], [data-testid="composer"]', main);
    const workTaskMarker = !!main.querySelector('[data-work-status], [data-task-status], [data-testid^="work-task-"], [data-testid^="agent-task-"]');
    const liveError = currentErrorKind(main);
    return {
      enabled, override, pathname: path,
      workModeSelected: selectedWorkMode(main),
      workTaskMarker,
      stopVisible: hasStopButton(main),
      composerVisible,
      optimisticSend: optimisticUntil > Date.now(),
      workRunningVisible: statusVisible(main, ACTIVE_TEXT),
      workDoneVisible: statusVisible(main, DONE_TEXT),
      attentionVisible: statusVisible(main, ATTENTION_TEXT) || attentionControlVisible(document),
      errorKind: liveError?.kind ?? null,
      errorNode: liveError?.node ?? null
    };
  }

  function faviconTargets() {
    return [...document.head.querySelectorAll('link[rel]')]
      .filter((el) => el !== managedIcon && /(^|\s)icon(\s|$)/i.test(el.rel));
  }

  function installIcon(state) {
    if (!document.head) return;
    // Keep originals in the document and restore them when disabled.
    for (const el of faviconTargets()) {
      previousIcons.set(el, el.getAttribute('rel'));
      el.setAttribute('rel', el.rel.split(/\s+/).filter((item) => item.toLowerCase() !== 'icon').join(' '));
    }
    for (const el of previousIcons.keys()) {
      if (!el.isConnected) previousIcons.delete(el);
    }
    if (!managedIcon || !managedIcon.isConnected) {
      managedIcon = document.createElement('link');
      managedIcon.id = 'chatgpt-tab-pulse-icon';
      managedIcon.rel = 'icon';
      managedIcon.type = 'image/png';
      managedIcon.sizes = '32x32';
      document.head.appendChild(managedIcon);
    }
    const href = ICONS[state] || ICONS.unknown;
    if (managedIcon.href !== href) managedIcon.href = href;
    // Preserve precedence if ChatGPT added an icon later.
    if (document.head.lastElementChild !== managedIcon) document.head.appendChild(managedIcon);
  }

  function restoreIcons() {
    managedIcon?.remove();
    managedIcon = null;
    for (const [node, rel] of previousIcons) {
      if (node.isConnected && !/(^|\s)icon(\s|$)/i.test(node.rel)) node.setAttribute('rel', rel);
    }
    previousIcons.clear();
  }

  function evaluate() {
    queued = false;
    if (lastUrl !== location.href) {
      lastUrl = location.href;
      if (lastPath !== location.pathname) {
        optimisticUntil = 0;
        // A different conversation cannot complete the previous run.
        current = null;
        attentionSince = null;
        pendingIdleSince = pendingAttentionSince = pendingFailureSince = 0;
        pendingFailureKind = null;
        lastRunningEvidenceAt = 0;
        lastErrorNode = null;
        lastErrorSeenAt = 0;
      }
      lastPath = location.pathname;
    }
    const signals = getSignals();
    if (signals.stopVisible) {
      optimisticUntil = 0;
      signals.optimisticSend = false;
    }
    const mode = detector.modeFor(signals);
    const now = Date.now();
    if (signals.errorNode !== lastErrorNode) {
      lastErrorNode = signals.errorNode;
      lastErrorSeenAt = lastErrorNode ? now : 0;
    }
    const priorVerifiedRun = current?.confirmed === true && ['thinking', 'working'].includes(current.state) && current.mode === mode;
    const priorRecentRun = current?.state === 'error' || current?.state === 'timeout';
    const inFailureWindow = (priorVerifiedRun || priorRecentRun) && now - lastRunningEvidenceAt <= FAILURE_GRACE_MS;
    const activeRunStart = priorVerifiedRun ? current.startedAt : priorRecentRun ? current.failureRunStartedAt : null;
    // A toast already present before the run started is not evidence about this run.
    if (!inFailureWindow || !activeRunStart || lastErrorSeenAt < activeRunStart - 50) signals.errorKind = null;
    const candidate = detector.stateFor(signals);
    const previous = current;
    let state = candidate;
    let completedRunStartedAt = null;
    let completionConfirmed = false;
    let failureRunStartedAt = null;
    const wasRunning = previous && ['thinking', 'working'].includes(previous.state);

    // A momentary disappearance of the Stop button is not a completed response.
    if (candidate === 'idle' && wasRunning && previous.mode === mode) {
      if (!pendingIdleSince) {
        pendingIdleSince = now;
        setTimeout(evaluate, STABLE_IDLE_MS + 20);
      }
      if (now - pendingIdleSince < STABLE_IDLE_MS) state = previous.state;
      else if (previous.confirmed === true && (mode === 'chat' && signals.composerVisible || mode === 'work' && signals.workDoneVisible)) {
        completedRunStartedAt = previous.startedAt;
        completionConfirmed = true;
      }
    } else {
      pendingIdleSince = 0;
    }

    // Approval controls should remain visible briefly before a macOS notification.
    if (candidate === 'attention' && previous?.state !== 'attention') {
      if (!pendingAttentionSince) {
        pendingAttentionSince = now;
        setTimeout(evaluate, STABLE_ATTENTION_MS + 20);
      }
      if (now - pendingAttentionSince < STABLE_ATTENTION_MS) {
        state = wasRunning ? previous.state : 'unknown';
      } else if (previous?.state !== 'attention') {
        attentionSince = pendingAttentionSince;
      }
    } else if (candidate !== 'attention') {
      pendingAttentionSince = 0;
    }

    // A transient error banner is not a failure. Require stable, same-kind evidence.
    if (candidate === 'error' || candidate === 'timeout') {
      if (pendingFailureKind !== signals.errorKind) {
        pendingFailureKind = signals.errorKind;
        pendingFailureSince = now;
        setTimeout(evaluate, STABLE_FAILURE_MS + 30);
      }
      if (now - pendingFailureSince < STABLE_FAILURE_MS) {
        state = wasRunning ? previous.state : 'unknown';
      } else {
        failureRunStartedAt = wasRunning ? previous.startedAt : previous.failureRunStartedAt;
      }
    } else {
      pendingFailureKind = null;
      pendingFailureSince = 0;
    }

    if (state !== 'attention') attentionSince = null;
    const isRunning = state === 'thinking' || state === 'working';
    const strongEvidence = signals.stopVisible || mode === 'work' && signals.workRunningVisible;
    const sameRun = isRunning && wasRunning && previous.mode === mode;
    const startedAt = isRunning ? (sameRun ? previous.startedAt : now) : null;
    const confirmed = isRunning && (strongEvidence || sameRun && previous.confirmed === true);
    if (confirmed && strongEvidence) lastRunningEvidenceAt = now;
    current = {
      state, mode, override, reason: detector.reasonFor(signals, state), enabled,
      startedAt, confirmed, completedRunStartedAt, completionConfirmed, attentionSince,
      errorKind: state === 'error' || state === 'timeout' ? signals.errorKind : null,
      failureRunStartedAt
    };
    if (state === 'disabled') restoreIcons();
    else installIcon(state);
    // Broadcast only state transitions, not the changing elapsed clock.
    // The single-use completion evidence is not included in repeated GET_STATUS results.
    const signature = JSON.stringify([state, mode, override, startedAt, confirmed, completedRunStartedAt, attentionSince, current.errorKind, failureRunStartedAt]);
    if (signature !== lastBroadcast) {
      lastBroadcast = signature;
      try {
        chrome.runtime.sendMessage({ type: 'TAB_STATUS_UPDATE', state, mode, override,
          startedAt, confirmed, completedRunStartedAt, completionConfirmed, attentionSince,
          errorKind: current.errorKind, failureRunStartedAt })
          .catch(() => { /* Worker might be restarting. */ });
      } catch (_) { /* Extension might be reloaded. */ }
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(evaluate, 180);
  }

  // Track submit events for the short gap before the stop button appears.
  // The state self-expires; a failed send cannot leave an endless "thinking" icon.
  document.addEventListener('submit', (event) => {
    if (event.target.closest('main') && event.target.matches('form')) {
      optimisticUntil = Date.now() + 3500;
      schedule();
    }
  }, true);

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
    attributeFilter: ['rel', 'href', 'hidden', 'aria-hidden', 'aria-label', 'aria-pressed', 'aria-selected', 'data-state', 'data-testid', 'class', 'style']
  });
  window.addEventListener('popstate', schedule);
  window.addEventListener('pageshow', schedule);
  const timer = setInterval(schedule, 3000);

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'GET_STATUS') {
      reply(current || { state: 'unknown', mode: 'chat', override, enabled, reason: '初期化中' });
    } else if (message?.type === 'SET_MODE') {
      writeOverride(message.mode);
      current = null;
      attentionSince = null;
      pendingIdleSince = pendingAttentionSince = pendingFailureSince = 0;
      pendingFailureKind = null;
      lastRunningEvidenceAt = 0;
      lastErrorNode = null;
      lastErrorSeenAt = 0;
      optimisticUntil = 0;
      evaluate();
      reply(current);
    }
    return false;
  });

  chrome.storage.local.get({ enabled: true }, (values) => {
    enabled = values.enabled !== false;
    evaluate();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.enabled) {
      enabled = changes.enabled.newValue !== false;
      evaluate();
    }
  });
  evaluate();
  // Stop interval on page teardown (browser will also unload the content script).
  window.addEventListener('pagehide', () => clearInterval(timer), { once: true });
})();
