"""Popup UI smoke test in Chromium with a mocked Chrome API. No account/network."""
from pathlib import Path
import base64
import re
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[1]
MOCK_API = r'''() => {
  window.__updates = [];
  window.__overviews = [
    {id:100, windowId:1, index:0, title:'Math Chat', state:'idle', mode:'chat'},
    {id:101, windowId:1, index:1, title:'Code Review', state:'thinking', mode:'chat', startedAt:Date.now()-84000},
    {id:102, windowId:2, index:0, title:'Work Research', state:'working', mode:'work'},
    {id:103, windowId:2, index:1, title:'Launch presentation', state:'attention', mode:'work'}
  ];
  window.close = () => { window.__closed = true; };
  window.chrome = {
    tabs: {
      query: async () => [{id:100, url:'https://chatgpt.com/c/a',title:'Math Chat'}],
      sendMessage: async () => ({state:'idle',reason:'入力待機中',override:'auto'}),
      update: async (id,options) => {window.__updates.push(['tab',id,options]);}
    },
    windows: {update: async (id,options) => {window.__updates.push(['window',id,options]);}},
    runtime: {sendMessage: async () => ({ok:true,tabs:window.__overviews})},
    permissions: {request: async () => true,remove: async () => true},
    storage: {local: {get: async (defaults) => ({...defaults,enabled:true}), set: async () => {}},
      onChanged:{addListener: () => {}}}
  };
}'''

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        page = browser.new_page(viewport={'width': 410,'height': 860})
        html = (ROOT/'popup.html').read_text()
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S)
        html = re.sub(r'<link rel="stylesheet"[^>]*>', '', html)
        # Inline local icons in the mock only; production popup uses packaged extension URLs.
        for icon in ['idle','thinking','working','attention','unknown']:
            png = base64.b64encode((ROOT/'icons'/f'{icon}-32.png').read_bytes()).decode('ascii')
            html = html.replace(f'icons/{icon}-32.png',f'data:image/png;base64,{png}')
        page.set_content(html)
        page.evaluate(MOCK_API)
        page.add_style_tag(path=str(ROOT/'popup.css'))
        page.add_script_tag(path=str(ROOT/'src/overview.js'))
        page.add_script_tag(path=str(ROOT/'src/notifications.js'))
        page.add_script_tag(path=str(ROOT/'popup.js'))
        page.wait_for_function("document.querySelector('#count-running')?.textContent === '2'")
        assert page.locator('#count-attention').inner_text() == '1'
        assert page.locator('#count-idle').inner_text() == '1'
        assert page.locator('#count-total').inner_text() == '4'
        print('PASS: popup aggregate counts (2 running / 1 attention / 1 idle / 4 total)')
        assert page.locator('#tab-list button').count() == 4
        assert '経過' in page.locator('#tab-list .tab-elapsed').first.inner_text()
        print('PASS: elapsed runtime visible in active tab row')
        assert page.locator('#tab-list .tab-item.current').count() == 1
        print('PASS: tab rows and current tab marker')
        assert page.locator('#tab-list img').count() == 0
        assert page.locator('#tab-list button').last.locator('img').count() == 0
        page.screenshot(path='/mnt/data/chatgpt-tab-pulse-popup-v0.4-preview.png',full_page=True)
        page.evaluate("window.__overviews[3].title = '<img src=x onerror=alert(1)>'")
        page.wait_for_function("Array.from(document.querySelectorAll('#tab-list .tab-title')).some(x => x.textContent.includes('<img src=x onerror=alert(1)>'))",timeout=6000)
        assert page.locator('#tab-list img').count() == 0
        print('PASS: title inserted as plain text (not parsed as HTML)')
        page.get_by_role('button', name='Work Research').click()
        page.wait_for_function('window.__updates.length === 2')
        assert page.evaluate('window.__updates[0][1]') == 102
        assert page.evaluate('window.__updates[1][1]') == 2
        assert page.evaluate('window.__closed') is True
        print('PASS: clicking row activates tab, focuses window, closes popup')
    finally:
        browser.close()
