/* Pure, strict classifier for present-tense system error banners only. */
(function(root) {
  'use strict';
  const PATTERNS = [
    ['timeout', /^(?:request (?:timed out|timeout)|(?:the )?request (?:has )?timed out|(?:task |operation )?timed out|(?:the )?operation timed out|timeout|タイムアウト(?:しました|が発生しました)?|時間切れ(?:になりました)?)\s*[.!。！]?$/i],
    ['network', /^(?:a network error (?:occurred|has occurred)|network error|network connection (?:lost|failed)|connection (?:lost|failed)|failed to connect|ネットワークエラー(?:が発生しました)?|通信エラー(?:が発生しました)?|接続が切れました)\s*[.!。！]?$/i],
    ['generation', /^(?:there was an error (?:generating a response|while generating a response)|error generating response|failed to generate (?:a )?response|(?:this )?task failed|something went wrong(?: while generating (?:a )?response)?|回答の生成(?:中)?にエラーが発生しました|応答の生成に失敗しました|タスク(?:の実行)?に失敗しました)\s*[.!。！]?$/i]
  ];
  function classify(text) {
    if (typeof text !== 'string') return null;
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized || normalized.length > 180) return null;
    for (const [kind, pattern] of PATTERNS) if (pattern.test(normalized)) return kind;
    return null;
  }
  const api = Object.freeze({classify});
  root.TabPulseErrorDetection = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
