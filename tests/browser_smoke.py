"""Mock DOM smoke test in headless Chromium. No ChatGPT account or network required."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """<!doctype html><html lang='ja'><head><title>Mock ChatGPT</title>
<link rel='icon' href='/original.ico'></head><body><main><form data-chatgpt-composer>
<textarea id='prompt-textarea'></textarea><button type='submit' data-testid='send-button'>Send</button>
</form></main></body></html>"""

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None), headless=True, args=['--no-sandbox'])
    try:
        page = browser.new_page()
        page.set_content(HTML)
        page.evaluate('''() => {
          globalThis.__statusUpdates = [];
          globalThis.chrome = {
            runtime: {getURL: p => 'https://example.invalid/'+p,
              sendMessage: async msg => {globalThis.__statusUpdates.push(msg);},
              onMessage: {addListener: fn => globalThis.__testMessageListener = fn}},
            storage: {local: {get: (defaults,fn) => fn({enabled:true})},
              onChanged:{addListener: fn => globalThis.__testStorageListener = fn}}
          };
        }''')
        page.add_script_tag(path=str(ROOT/'src'/'detector.js'))
        page.add_script_tag(path=str(ROOT/'src'/'error-detection.js'))
        page.add_script_tag(path=str(ROOT/'src'/'content.js'))
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')", timeout=5000)
        print('PASS: Chat idle favicon')
        page.locator('main form').evaluate("el => {const stop = document.createElement('button');stop.type='button';stop.dataset.testid='stop-button';stop.textContent='Stop';el.appendChild(stop)}")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        print('PASS: Chat thinking favicon')
        page.locator('[data-testid="stop-button"]').evaluate('(el)=>el.remove()')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')")
        print('PASS: Chat returns idle')
        page.locator('main').evaluate("el => {const b = document.createElement('button');b.setAttribute('aria-pressed','true');b.innerText='Work';el.appendChild(b)}")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('unknown-32.png')")
        print('PASS: Work unknown without task evidence')
        page.locator('main').evaluate("el => {const b = document.createElement('button');b.dataset.testid='stop-button';b.innerText='Stop';el.appendChild(b)}")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('working-32.png')")
        print('PASS: Work working favicon')
        page.locator('[data-testid="stop-button"]').evaluate('(el)=>el.remove()')
        page.locator('main').evaluate("el => {const x=document.createElement('div');x.setAttribute('data-task-status','completed');x.setAttribute('role','status');x.textContent='Completed';el.appendChild(x)}")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')")
        print('PASS: Work completed indication')
        page.locator('[data-task-status]').evaluate('(el)=>el.remove()')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('unknown-32.png')")
        print('PASS: Work returns unknown without proof')
        # Action popup's override lets Work be explicitly selected per tab.
        response = page.evaluate("""() => {let reply; __testMessageListener({type:'SET_MODE',mode:'chat'}, {}, (x)=>reply=x);return reply;}""")
        assert response['state']=='idle', response
        print('PASS: Mode override via popup message')
        page.evaluate("""() => {
          __testMessageListener({type:'SET_MODE',mode:'work'}, {}, () => {});
          const d=document.createElement('div');d.setAttribute('role','dialog');
          const b=document.createElement('button');b.textContent='Approve';
          d.appendChild(b);document.querySelector('main').appendChild(d);
        }""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('attention-32.png')")
        print('PASS: Work approval attention favicon')
        # Old chat text cannot cause a timeout; only live alert UI is eligible.
        page.evaluate("""() => {
          __testMessageListener({type:'SET_MODE',mode:'chat'}, {}, () => {});
          document.querySelector('[role=dialog]')?.remove();
          const form = document.querySelector('main form');
          const b=document.createElement('button');b.dataset.testid='stop-button';b.textContent='Stop';b.type='button';form.appendChild(b);
          const old=document.createElement('p');old.textContent='Request timed out';old.id='old-message';document.querySelector('main').appendChild(old);
        }""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        page.wait_for_timeout(1300)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        print('PASS: old message text cannot trigger error')
        # Do not count a short-lived toast as a true failure.
        page.evaluate("""() => {const x=document.createElement('div');x.id='test-alert';x.setAttribute('role','alert');x.textContent='Request timed out';document.querySelector('main').appendChild(x)}""")
        page.wait_for_timeout(300)
        page.evaluate("document.querySelector('#test-alert').remove()")
        page.wait_for_timeout(1250)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        print('PASS: transient timeout alert ignored')
        page.evaluate("""() => {const x=document.createElement('div');x.id='test-alert';x.setAttribute('role','alert');x.textContent='Request timed out';document.querySelector('main').appendChild(x)}""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=4500)
        status = page.evaluate("""() => {let result;__testMessageListener({type:'GET_STATUS'}, {}, x=>result=x);return result;}""")
        assert status['errorKind']=='timeout' and status['failureRunStartedAt']
        print('PASS: sustained current run timeout alert confirmed')
        # Advancing virtual time by 95s must not erase a continuously visible confirmed timeout.
        # Only Date.now advances; the DOM and timers continue running normally.
        page.evaluate("""() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 95000; }""")
        page.wait_for_timeout(3400)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')")
        print('PASS: confirmed visible timeout remains latched beyond 95s')
        page.evaluate("() => {Date.now = window.__realNow; delete window.__realNow;}")
        page.evaluate("document.querySelector('#test-alert').remove()")
        page.evaluate("document.querySelector('[data-testid=stop-button]')?.remove()")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=5000)
        # A late timeout after Stop disappears and idle debounce expires must still be detected.
        page.evaluate("""() => {const b=document.createElement('button');b.dataset.testid='stop-button';b.type='button';b.textContent='Stop';document.querySelector('main form').appendChild(b)}""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        run = page.evaluate("""() => {let result;__testMessageListener({type:'GET_STATUS'}, {}, x=>result=x);return result.startedAt;}""")
        assert run
        page.evaluate("document.querySelector('[data-testid=stop-button]').remove()")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=5000)
        page.wait_for_timeout(350)
        page.evaluate("""() => {const x=document.createElement('div');x.id='test-alert';x.setAttribute('role','alert');x.textContent='Request timed out';document.querySelector('main').appendChild(x)}""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=4500)
        late = page.evaluate("""() => {let result;__testMessageListener({type:'GET_STATUS'}, {}, x=>result=x);return result;}""")
        assert late['failureRunStartedAt']==run,late
        assert page.evaluate("""() => __statusUpdates.some(x => x.state==='idle' && x.recentRunStartedAt)""")
        print('PASS: timeout 1.8s after Stop disappeared retains original run identity')
        # An alert from a prior run must not fail a newly-started run.
        page.evaluate("document.querySelector('#test-alert').remove()")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=5000)
        page.evaluate("""() => {const x=document.createElement('div');x.id='test-alert';x.setAttribute('role','alert');x.textContent='Request timed out';document.querySelector('main').appendChild(x)}""")
        page.wait_for_timeout(400)
        page.evaluate("""() => {const b=document.createElement('button');b.dataset.testid='stop-button';b.type='button';b.textContent='Stop';document.querySelector('main form').appendChild(b)}""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')",timeout=4000)
        page.wait_for_timeout(1350)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        print('PASS: pre-existing error banner cannot fail a new run')
        page.evaluate("document.querySelector('#test-alert').remove()")
        page.evaluate("document.querySelector('[data-testid=stop-button]').remove()")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=5000)
        page.evaluate("() => __testStorageListener({enabled:{newValue:false}},'local')")
        page.wait_for_function("!document.querySelector('#chatgpt-tab-pulse-icon')")
        assert page.locator('link[href="/original.ico"]').get_attribute('rel') == 'icon'
        print('PASS: Disabled restores original favicon')
        page.close()
    finally:
        browser.close()
