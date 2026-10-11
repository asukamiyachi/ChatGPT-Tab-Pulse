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
  let pendingFailureNode = null;
  let completionNotifiedRun = null;
  let failedRun = null;
  let cancelledRun = null;
  let lastRunningEvidenceAt = 0;
  // A verified run remains eligible for a late error after the Stop control vanishes.
  let recentRunStartedAt = null;
  let recentRunMode = null;
  // A confirmed failure remains visible while its original banner is still present.
  let latchedFailure = null;
  let previousStrongEvidence = false;
  // Track the FIRST appearance of each system banner, including when React
  // changes a banner's text in place. The DOM itself is never persisted.
  const errorObservations = new WeakMap();
  const completionObservations = new WeakMap();
  let attentionSince = null;
  const STABLE_IDLE_MS = 1400;
  const STABLE_ATTENTION_MS = 850;
  const STABLE_FAILURE_MS = 1100;
  const FAILURE_GRACE_MS = 90000;
  const STABLE_COMPLETION_MS = 5000; // Give delayed failure toasts time to arrive.
  const FAILURE_REDRAW_GAP_MS = 1200;
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
      if (!visible(el) || el.closest(NON_TASK_ALERT_CONTEXT)) continue;
      const direct = el.getAttribute('data-work-status') || el.getAttribute('data-task-status');
      const content = normalized(direct || el.textContent);
      if (content.length <= 100 && pattern.test(content)) return true;
    }
    return false;
  }

  const NON_TASK_ALERT_CONTEXT = [
    '[role="dialog"]', '[role="alertdialog"]', 'aside', 'nav',
    '[data-testid*="settings"]', '[data-testid*="preferences"]',
    '[data-testid*="account"]', '[data-testid*="profile"]',
    '[data-testid*="notification"]', '[data-state="open"][role="menu"]',
    '[aria-label*="Settings"]', '[aria-label*="設定"]',
    '[data-message-author-role]', '[data-testid^="conversation-turn-"]'
  ].join(',');

  function completionEvidenceAt(main, now = Date.now()) {
    let newest = 0;
    const selector = '[role="status"], [data-work-status], [data-task-status], [data-testid*="task-status"], [data-testid*="work-status"]';
    for (const node of main.querySelectorAll(selector)) {
      if (!visible(node) || node.closest(NON_TASK_ALERT_CONTEXT)) continue;
      const raw = node.getAttribute('data-work-status') || node.getAttribute('data-task-status') || node.textContent;
      const fingerprint = normalized(raw);
      const done = fingerprint.length <= 100 && DONE_TEXT.test(fingerprint);
      let observed = completionObservations.get(node);
      // Observe both edges: Completed -> Running -> Completed on the same
      // element is a new completion; changing Completed wording is not.
      if (!observed || observed.done !== done) {
        observed = {done, since: now};
        completionObservations.set(node, observed);
      }
      if (done) newest = Math.max(newest, observed.since);
    }
    return newest;
  }

  function errorMessageWithoutControls(node) {
    // System banners often contain a Retry button. Button labels are not
    // part of the error message and must not defeat strict classification.
    const copy = node.cloneNode(true);
    for (const control of copy.querySelectorAll('button, a, input, select, textarea, svg, [role="button"]')) {
      control.remove();
    }
    return copy.textContent || '';
  }

  function currentErrors(main, now = Date.now()) {
    // An alert must belong to the live conversation/task area, not a settings
    // dialog, toast in a navigation panel, or historical conversation content.
    const selectors = '[role="alert"], [role="alertdialog"], [data-testid="error-message"], [data-testid="response-error"], [data-testid="task-error"], [data-task-status], [data-work-status]';
    const candidates = [];
    for (const node of main.querySelectorAll(selectors)) {
      if (!visible(node) || node.closest(NON_TASK_ALERT_CONTEXT)) continue;
      const status = normalized(node.getAttribute('data-task-status') || node.getAttribute('data-work-status'));
      const message = errorMessageWithoutControls(node);
      // Parse status attributes and visible copy independently: a machine
      // status of "failed" can accompany a useful "Task failed" message.
      const kind = errors.classify(message) || errors.classify(status) ||
        ((node.hasAttribute('data-task-status') || node.hasAttribute('data-work-status')) &&
         /^(failed|failure)$/.test(status) ? 'generation' : null);
      const isError = !!kind;
      let observed = errorObservations.get(node);
      // Track recovery even when this element is not an error. A later
      // normal -> error transition is new evidence for a new run, whereas
      // timeout -> network without an intervening normal state is not.
      if (!observed || observed.isError !== isError) {
        observed = {isError, since: now};
        errorObservations.set(node, observed);
      }
      if (!isError) continue;
      const fingerprint = normalized(message || status);
      candidates.push({node, kind, fingerprint, since: observed.since});
    }
    return candidates;
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

  function getSignals(now = Date.now()) {
    const main = document.querySelector('main') || document.body;
    const path = location.pathname;
    const composerVisible = anyVisible(
      'form[data-chatgpt-composer] textarea, [data-testid="composer"] textarea, #prompt-textarea, [contenteditable="true"][data-testid*="composer"], [contenteditable="true"]#prompt-textarea',
      main
    ) || anyVisible('form[data-chatgpt-composer], [data-testid="composer"]', main);
    const workTaskMarker = !!main.querySelector('[data-work-status], [data-task-status], [data-testid^="work-task-"], [data-testid^="agent-task-"]');
    const liveErrors = currentErrors(main, now);
    const doneObservedAt = completionEvidenceAt(main, now);
    return {
      enabled, override, pathname: path,
      workModeSelected: selectedWorkMode(main),
      workTaskMarker,
      stopVisible: hasStopButton(main),
      composerVisible,
      optimisticSend: optimisticUntil > Date.now(),
      workRunningVisible: statusVisible(main, ACTIVE_TEXT),
      workDoneVisible: statusVisible(main, DONE_TEXT),
      // Completion requires positive evidence. Composer reappearance is not
      // enough: it happens after a user cancels a response as well.
      chatDoneVisible: statusVisible(main, DONE_TEXT),
      doneObservedAt,
      attentionVisible: statusVisible(main, ATTENTION_TEXT) || attentionControlVisible(document),
      errorCandidates: liveErrors,
      errorKind: null,
      errorNode: null
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
        pendingFailureNode = null;
        completionNotifiedRun = null;
        failedRun = null;
        cancelledRun = null;
        lastRunningEvidenceAt = 0;
        recentRunStartedAt = null;
        recentRunMode = null;
        latchedFailure = null;
        previousStrongEvidence = false;
      }
      lastPath = location.pathname;
    }
    // Sample the UI at one time: a Stop control and a system error may
    // first appear in the same DOM mutation batch.
    const now = Date.now();
    const signals = getSignals(now);
    if (signals.stopVisible) {
      optimisticUntil = 0;
      signals.optimisticSend = false;
    }
    const mode = detector.modeFor(signals);
    const strongEvidenceNow = signals.stopVisible || (mode === 'work' && signals.workRunningVisible);
    // Only a new confirmed run can invalidate a latched failure.
    if (strongEvidenceNow && !previousStrongEvidence &&
        (!current || ['idle', 'unknown', 'error', 'timeout'].includes(current.state))) {
      recentRunStartedAt = null;
      recentRunMode = null;
      latchedFailure = null;
      pendingFailureKind = null;
      pendingFailureNode = null;
      pendingIdleSince = 0;
      completionNotifiedRun = null;
      failedRun = null;
      cancelledRun = null;
      lastRunningEvidenceAt = 0;
    }
    previousStrongEvidence = strongEvidenceNow;
    const sameRecentRun = recentRunStartedAt && recentRunMode === mode;
    const withinGrace = sameRecentRun && now - lastRunningEvidenceAt <= FAILURE_GRACE_MS;
    const candidates = signals.errorCandidates;
    let matchedError = null;
    if (sameRecentRun && latchedFailure && latchedFailure.runStartedAt === recentRunStartedAt) {
      // A redraw gap begins when the error first disappears, NOT when the
      // periodic observer last noticed it. Otherwise timer alignment could
      // consume the entire grace period before React starts its redraw.
      const originalPresent = candidates.some(e => e.node === latchedFailure.node &&
        e.kind === latchedFailure.kind);
      if (!originalPresent && latchedFailure.missingSinceMono === null) {
        latchedFailure.missingSinceMono = performance.now();
      }
      const withinRedraw = latchedFailure.missingSinceMono === null ||
        performance.now() - latchedFailure.missingSinceMono <= FAILURE_REDRAW_GAP_MS;
      // A prior-run banner is never eligible, even if its text is identical.
      matchedError = candidates.find(e => e.kind === latchedFailure.kind &&
        (e.node === latchedFailure.node ||
          (withinRedraw && e.since > recentRunStartedAt &&
           // A replacement may alter the wording but must still be associated
           // with the same task and error type, never a historical banner.
           e.since >= latchedFailure.firstSeenAt))) || null;
      if (matchedError) latchedFailure.missingSinceMono = null;
    }
    if (!matchedError && withinGrace && !latchedFailure) {
      // Multiple alerts can coexist. Prefer a new banner belonging to this run
      // rather than the first, potentially historical, matching DOM element.
      // Equal timestamps are intentional: verified Stop and a new error can
      // appear together in a single mutation frame. Previously observed
      // banners retain their earlier 'since' across text changes.
      matchedError = candidates.filter(e => e.since >= recentRunStartedAt)
        .sort((a,b) => b.since - a.since)[0] || null;
    }
    // If the old error disappeared, do not latch an unrelated banner.
    // A two-phase React remount can briefly leave no matching node. Keep only
    // the identity (not a success/error assertion) for a bounded redraw gap.
    if (!matchedError && latchedFailure && latchedFailure.missingSinceMono !== null) {
      const remaining = FAILURE_REDRAW_GAP_MS -
        (performance.now() - latchedFailure.missingSinceMono);
      if (remaining <= 0) latchedFailure = null;
      else setTimeout(evaluate, remaining + 30);
    }
    // During a short React redraw gap, keep the *already confirmed* error
    // visible instead of inventing a new run from a persistent Stop control.
    signals.errorKind = matchedError?.kind || latchedFailure?.kind || null;
    signals.errorNode = matchedError?.node || latchedFailure?.node || null;
    const candidate = detector.stateFor(signals);
    const previous = current;
    let state = candidate;
    let completedRunStartedAt = null;
    let completionConfirmed = false;
    let failureRunStartedAt = null;
    const wasRunning = previous && ['thinking', 'working'].includes(previous.state);

    // The composer returning is only provisional: delayed error banners may
    // appear after Stop disappears. Keep the run ID while idle and postpone
    // the opt-in completion notice until the UI has settled without errors.
    const eligibleForCompletion = candidate === 'idle' && sameRecentRun &&
      !failedRun && cancelledRun !== recentRunStartedAt &&
      completionNotifiedRun !== recentRunStartedAt &&
      (mode === 'chat' ? signals.chatDoneVisible : signals.workDoneVisible) &&
      signals.doneObservedAt >= recentRunStartedAt;
    if (eligibleForCompletion &&
        (wasRunning || previous?.state === 'idle' && previous.mode === mode)) {
      if (!pendingIdleSince) {
        pendingIdleSince = now;
        setTimeout(evaluate, STABLE_IDLE_MS + 20);
        setTimeout(evaluate, STABLE_COMPLETION_MS + 30);
      }
      if (now - pendingIdleSince < STABLE_IDLE_MS) {
        state = wasRunning ? previous.state : 'idle';
      } else if (now - pendingIdleSince >= STABLE_COMPLETION_MS) {
        completedRunStartedAt = recentRunStartedAt;
        completionConfirmed = true;
        completionNotifiedRun = recentRunStartedAt;
      }
    } else if (candidate !== 'idle' || !sameRecentRun || failedRun) {
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
      if (latchedFailure && latchedFailure.runStartedAt === recentRunStartedAt &&
          latchedFailure.kind === signals.errorKind) {
        // This is the same previously confirmed failure, possibly mid-redraw.
        failureRunStartedAt = recentRunStartedAt;
        if (matchedError) latchedFailure = {
          ...latchedFailure, node: matchedError.node, missingSinceMono: null
        };
      } else {
        if (pendingFailureKind !== signals.errorKind || pendingFailureNode !== signals.errorNode) {
          pendingFailureKind = signals.errorKind;
          pendingFailureNode = signals.errorNode;
          pendingFailureSince = now;
          setTimeout(evaluate, STABLE_FAILURE_MS + 30);
        }
        if (now - pendingFailureSince < STABLE_FAILURE_MS) {
          state = wasRunning ? previous.state : 'unknown';
        } else {
          failureRunStartedAt = recentRunStartedAt;
          latchedFailure = {
            node: matchedError.node, kind: matchedError.kind,
            fingerprint: matchedError.fingerprint, missingSinceMono: null,
            firstSeenAt: matchedError.since,
            runStartedAt: recentRunStartedAt
          };
          failedRun = recentRunStartedAt;
          pendingIdleSince = 0;
        }
      }
    } else {
      pendingFailureKind = null;
      pendingFailureNode = null;
      pendingFailureSince = 0;
    }

    if (state !== 'attention') attentionSince = null;
    const isRunning = state === 'thinking' || state === 'working';
    const strongEvidence = signals.stopVisible || mode === 'work' && signals.workRunningVisible;
    const sameRun = isRunning && wasRunning && previous.mode === mode;
    const startedAt = isRunning ? (sameRun ? previous.startedAt : now) : null;
    const confirmed = isRunning && (strongEvidence || sameRun && previous.confirmed === true);
    if (confirmed && strongEvidence) {
      recentRunStartedAt = startedAt;
      recentRunMode = mode;
      lastRunningEvidenceAt = now;
      latchedFailure = null;
      // During this evaluation the run did not yet have an ID when error
      // candidates were checked. Re-evaluate only when a new banner was
      // observed in the exact same frame as the newly confirmed run.
      if (!sameRun && signals.errorCandidates.some(e => e.since === startedAt)) {
        setTimeout(evaluate, 30);
      }
    }
    if (state === 'disabled') {
      recentRunStartedAt = null;
      recentRunMode = null;
      latchedFailure = null;
      failedRun = null;
      cancelledRun = null;
      pendingIdleSince = 0;
    }
    current = {
      state, mode, override, reason: detector.reasonFor(signals, state), enabled,
      startedAt, confirmed, completedRunStartedAt, completionConfirmed, attentionSince,
      errorKind: state === 'error' || state === 'timeout' ? signals.errorKind : null,
      failureRunStartedAt,
      recentRunStartedAt: recentRunMode === mode ? recentRunStartedAt : null,
      recentRunObservedAt: recentRunMode === mode ? lastRunningEvidenceAt : null
    };
    if (state === 'disabled') restoreIcons();
    else installIcon(state);
    // Broadcast only state transitions, not the changing elapsed clock.
    // The single-use completion evidence is not included in repeated GET_STATUS results.
    const signature = JSON.stringify([state, mode, override, startedAt, confirmed, completedRunStartedAt, attentionSince, current.errorKind, failureRunStartedAt, current.recentRunStartedAt]);
    if (signature !== lastBroadcast) {
      lastBroadcast = signature;
      try {
        chrome.runtime.sendMessage({ type: 'TAB_STATUS_UPDATE', state, mode, override,
          startedAt, confirmed, completedRunStartedAt, completionConfirmed, attentionSince,
          errorKind: current.errorKind, failureRunStartedAt,
          recentRunStartedAt: current.recentRunStartedAt,
          recentRunObservedAt: current.recentRunObservedAt })
          .catch(() => { /* Worker might be restarting. */ });
      } catch (_) { /* Extension might be reloaded. */ }
    }
  }

  function schedule() {
    if (queued) return;
    queued = true;
    setTimeout(evaluate, 180);
  }

  // A user-initiated Stop/Cancel is NOT successful completion. Both mouse and
  // keyboard button activation dispatch click; capture before the UI removes it.
  document.addEventListener('click', (event) => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || !button.closest('main') || !visible(button)) return;
    const stopButton = button.matches(STOP_SELECTORS) ||
      [button.getAttribute('aria-label'), button.title, button.textContent]
        .some(v => STOP_TEXT.test(normalized(v)));
    if (!stopButton || !recentRunStartedAt || !current?.confirmed) return;
    cancelledRun = recentRunStartedAt;
    pendingIdleSince = 0;
  }, true);

  // Track submit events for the short gap before the stop button appears.
  // The state self-expires; a failed send cannot leave an endless "thinking" icon.
  document.addEventListener('submit', (event) => {
    if (event.target.closest('main') && event.target.matches('form')) {
      // A new chat submission invalidates the previous run, even while an old alert remains.
      recentRunStartedAt = null;
      recentRunMode = null;
      latchedFailure = null;
      lastRunningEvidenceAt = 0;
      pendingFailureKind = null;
      pendingFailureNode = null;
      pendingIdleSince = 0;
      completionNotifiedRun = null;
      failedRun = null;
      cancelledRun = null;
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
      pendingFailureNode = null;
      completionNotifiedRun = null;
      failedRun = null;
      cancelledRun = null;
      lastRunningEvidenceAt = 0;
      recentRunStartedAt = null;
      recentRunMode = null;
      latchedFailure = null;
      previousStrongEvidence = false;
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
