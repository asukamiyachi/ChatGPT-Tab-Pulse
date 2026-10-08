/* Pure detection rules, separately testable with Node.js. */
(function (root) {
  "use strict";

  const MODES = Object.freeze(["auto", "chat", "work"]);

  function modeFor(context) {
    if (context.override === "chat" || context.override === "work") {
      return context.override;
    }
    if (context.workModeSelected || context.workTaskMarker || /\/(work|agent|operator)(\/|$)/i.test(context.pathname || "")) {
      return "work";
    }
    return "chat";
  }

  function stateFor(signals) {
    if (!signals.enabled) return "disabled";
    const mode = modeFor(signals);
    if (mode === "work" && signals.attentionVisible) return "attention";
    if (signals.stopVisible) return mode === "work" ? "working" : "thinking";
    if (mode === "work" && signals.workRunningVisible) return "working";
    if (mode === "work") {
      // Missing a stop button is NOT proof that a remote Work task completed.
      return signals.workDoneVisible ? "idle" : "unknown";
    }
    if (signals.composerVisible) return signals.optimisticSend ? "thinking" : "idle";
    return "unknown";
  }

  function reasonFor(signals, state) {
    switch (state) {
      case "disabled": return "拡張機能がオフです";
      case "thinking": return signals.stopVisible ? "応答停止ボタンを検出" : "メッセージ送信を検出（暫定）";
      case "working": return signals.stopVisible ? "停止ボタンを検出" : "Workの進行中表示を検出";
      case "attention": return "Workの確認・承認待ち表示を検出";
      case "idle": return modeFor(signals) === "work" ? "Workの完了表示を検出" : "入力欄が使用可能で停止ボタンがありません";
      default: return modeFor(signals) === "work" ? "Workの確実な状態表示を確認できません" : "ChatGPTの入力欄を確認できません";
    }
  }

  const api = Object.freeze({ MODES, modeFor, stateFor, reasonFor });
  root.ChatGPTStatusDetector = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
