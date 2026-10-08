"""Codex panel browser test with mocked Chrome APIs, no real token, no network."""
from pathlib import Path
import re
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''() => {
  window.__session = {};
  window.__originGrant = false;
  window.__requestCount = 0;
  window.__url = null;
  window.__headers = null;
  window.__response = {
    schemaVersion:2, source:'codex-app-server', receivedAt:new Date().toISOString(),
    fiveHour:{remainingPercent:65,usedPercent:35,windowDurationMins:300,resetsAt:new Date(Date.now()+7200000).toISOString()},
    weekly:{remainingPercent:41,usedPercent:59,windowDurationMins:10080,resetsAt:new Date(Date.now()+172800000).toISOString()},
    bankedResets:{availableCount:0}
  };
  window.__http = 200;
  window.chrome = {
    tabs:{query:async()=>[],sendMessage:async()=>{},update:async()=>{}},
    windows:{update:async()=>{}},runtime:{sendMessage:async()=>({ok:true,tabs:[]})},
    permissions:{contains:async() => window.__originGrant, request:async()=>{window.__requestCount++;window.__originGrant=true;return true;},remove:async()=>{window.__originGrant=false;return true;}},
    storage:{session:{get:async(key)=>({[key]:window.__session[key]}),set:async(val)=>Object.assign(window.__session,val),remove:async(key)=>delete window.__session[key]},
      local:{get:async(defaults)=>defaults,set:async()=>{}},onChanged:{addListener:()=>{}}}
  };
  window.fetch = async (url,options) => {
    window.__url=url;window.__headers=options.headers;
    return {ok:window.__http===200,status:window.__http,json:async()=>window.__response};
  };
}'''
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        page=browser.new_page(viewport={'width':430,'height':940})
        html=re.sub(r'<script[^>]*>.*?</script>','',(ROOT/'popup.html').read_text(),flags=re.S)
        html=re.sub(r'<link rel="stylesheet"[^>]*>','',html)
        page.set_content(html)
        page.evaluate(MOCK)
        page.add_style_tag(path=str(ROOT/'popup.css'))
        for f in ['src/overview.js','src/notifications.js','popup.js','src/codex-usage.js','src/codex-panel.js']:
            page.add_script_tag(path=str(ROOT/f))
        assert page.locator('#codex-values').is_hidden()
        assert page.evaluate('window.__requestCount') == 0
        print('PASS: no permission or network before opt-in')
        page.locator('#codex-token').fill('sample_test_read_token_aaaaaaaaaaaaaaaa')
        page.locator('#codex-connect').click()
        page.wait_for_function("document.querySelector('#codex-five-value').textContent === '65% 残り'")
        assert page.locator('#codex-weekly-value').inner_text() == '41% 残り'
        assert page.locator('#codex-banked').inner_text() == '0 回'
        assert page.evaluate('window.__requestCount') == 1
        assert page.evaluate('window.__url') == 'https://codex-usage-manager.vercel.app/api/usage'
        assert page.evaluate('window.__headers.Authorization') == 'Bearer sample_test_read_token_aaaaaaaaaaaaaaaa'
        assert page.locator('#codex-token').input_value() == ''
        assert 'sample_test_read_token' not in page.content()
        print('PASS: explicit permission, read-only request, token not left in DOM, correct usage display')
        page.screenshot(path='/mnt/data/chatgpt-tab-pulse-v0.5-preview.png',full_page=True)
        page.evaluate("window.__response.receivedAt = new Date(Date.now()-3600000).toISOString()")
        page.locator('#codex-refresh').click()
        page.wait_for_function("document.querySelector('#codex-panel').dataset.freshness === 'stale'")
        assert page.locator('#codex-five-value').inner_text() == '参考値（古いデータ）'
        assert page.locator('#codex-weekly-bar').is_hidden()
        print('PASS: stale data blocked from current balance display')
        page.evaluate('window.__http=401')
        page.locator('#codex-refresh').click()
        page.wait_for_function("document.querySelector('#codex-message').textContent.includes('無効または期限切れ')")
        assert page.locator('#codex-values').is_hidden()
        print('PASS: auth failure clears visible values')
        page.locator('#codex-disconnect').click()
        page.wait_for_function("document.querySelector('#codex-link-status').textContent === '未接続'")
        assert page.evaluate('window.__session.codexReadToken') is None
        assert page.evaluate('window.__originGrant') is False
        print('PASS: disconnect removes token and host permission')
        assert page.locator('#count-total').inner_text() == '0'
        print('PASS: existing multi-tab UI remains functional')
    finally:
        browser.close()
