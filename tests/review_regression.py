"""Regression checks for cancelled responses, retained errors, and unrelated alerts.

Uses only a mock ChatGPT DOM; no account, network, or real Work integration.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """<!doctype html><html><head><link rel='icon' href='/original.ico'></head>
<body><main><form data-chatgpt-composer><textarea id='prompt-textarea'></textarea>
<button type='submit'>Send</button></form></main></body></html>"""


def open_page(browser):
    page = browser.new_page()
    page.set_content(HTML)
    page.evaluate('''() => {
      window.messages=[];
      window.chrome={runtime:{getURL:p=>'https://example.invalid/'+p,
        sendMessage:async m=>{window.messages.push(m)},onMessage:{addListener:f=>window.listener=f}},
        storage:{local:{get:(defaults,cb)=>cb({enabled:true})},onChanged:{addListener:()=>{}}}};
    }''')
    for file in ('src/detector.js','src/error-detection.js','src/content.js'):
        page.add_script_tag(path=str(ROOT / file))
    page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')")
    return page


def show_stop(page):
    page.evaluate('''() => {
      const b=document.createElement('button');b.type='button';b.dataset.testid='stop-button';
      b.textContent='Stop';document.querySelector('main form').appendChild(b)
    }''')
    page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")


def add_done(page):
    page.evaluate('''() => {
      const n=document.createElement('div');n.setAttribute('role','status');
      n.textContent='Completed';document.querySelector('main').appendChild(n)
    }''')


def no_completion(page):
    assert not page.evaluate('messages.some(m=>m.completionConfirmed)'), page.evaluate('messages')


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or (
        '/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None),
        headless=True, args=['--no-sandbox'])
    try:
        # Explicit manual Stop is never success even if the UI shows Completed.
        page=open_page(browser)
        show_stop(page)
        page.locator('[data-testid=stop-button]').click()
        page.locator('[data-testid=stop-button]').evaluate('(n)=>n.remove()')
        add_done(page)
        page.wait_for_timeout(6000)
        no_completion(page)
        print('PASS: manual Stop suppresses success notification despite completion marker',flush=True)
        page.close()

        # A mere disappearance of Stop and presence of composer is not success.
        page=open_page(browser)
        show_stop(page)
        page.locator('[data-testid=stop-button]').evaluate('(n)=>n.remove()')
        page.wait_for_timeout(6100)
        no_completion(page)
        print('PASS: Stop disappearance alone never confirms completion',flush=True)
        page.close()

        # Confirmed error remains when *same node* changes wording at +95 seconds.
        page=open_page(browser)
        show_stop(page)
        page.evaluate('''() => {
          const a=document.createElement('div');a.id='live-alert';a.setAttribute('role','alert');
          a.textContent='Request timed out';document.querySelector('main').appendChild(a)
        }''')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')")
        page.evaluate('''() => {window.realNow=Date.now;Date.now=()=>realNow()+95000}''')
        page.wait_for_timeout(3400)
        page.evaluate("document.querySelector('#live-alert').textContent='Timeout'")
        page.wait_for_timeout(650)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')")
        print('PASS: same-node text update after 95s retains confirmed failure',flush=True)
        page.close()

        # No generic settings/modal alert should be attributed to a running task.
        page=open_page(browser)
        show_stop(page)
        page.evaluate('''() => {
          let x=document.createElement('section');x.dataset.testid='settings-panel';
          let a=document.createElement('div');a.setAttribute('role','alert');a.textContent='Something went wrong';
          x.appendChild(a);document.querySelector('main').appendChild(x);
          let d=document.createElement('div');d.setAttribute('role','dialog');
          let b=document.createElement('div');b.setAttribute('role','alert');b.textContent='Request timed out';
          d.appendChild(b);document.querySelector('main').appendChild(d)
        }''')
        page.wait_for_timeout(1600)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
        print('PASS: unrelated settings/dialog alerts never become task errors',flush=True)
        # Genuine task-local banner is still detected when settings panels coexist.
        page.evaluate('''() => {
          const a=document.createElement('div');a.id='live';a.setAttribute('role','alert');
          a.textContent='Request timed out';document.querySelector('main').appendChild(a)
        }''')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=4000)
        print('PASS: active task error wins alongside unrelated settings errors',flush=True)
        page.close()

        # Stale success marker from a previous run must not confirm current run.
        page=open_page(browser)
        add_done(page)
        page.wait_for_timeout(350)
        show_stop(page)
        page.locator('[data-testid=stop-button]').evaluate('(n)=>n.remove()')
        page.wait_for_timeout(6100)
        no_completion(page)
        print('PASS: stale previous-run completion marker is rejected',flush=True)
        page.close()

        # Reuse exactly the same alert node across two different runs.
        # A real recovery (error -> normal) must reset its occurrence time.
        page=open_page(browser)
        show_stop(page)
        page.evaluate("""() => {
          const a=document.createElement('div');a.id='reused-alert';
          a.setAttribute('role','alert');a.textContent='Request timed out';
          document.querySelector('main').appendChild(a)
        }""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')")
        first=page.evaluate("""() => {let x;listener({type:'GET_STATUS'}, {}, r=>x=r);return x.failureRunStartedAt;}""")
        page.evaluate("""() => {
          document.querySelector('[data-testid=stop-button]').remove();
          document.querySelector('#reused-alert').textContent='Working';
        }""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=6000)
        show_stop(page)
        second=page.evaluate("""() => {let x;listener({type:'GET_STATUS'}, {}, r=>x=r);return x.startedAt;}""")
        assert first and second and first != second, (first,second)
        page.evaluate("document.querySelector('#reused-alert').textContent='Network error'")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('error-32.png')",timeout=4500)
        result=page.evaluate("""() => {let x;listener({type:'GET_STATUS'}, {}, r=>x=r);return x;}""")
        assert result['errorKind']=='network' and result['failureRunStartedAt']==second, result
        print('PASS: same alert node error -> normal -> new error belongs to new run',flush=True)
        page.close()

        # Existing Completed -> Running -> Completed element must be a new
        # completion, whereas a never-changing historical Completed is ignored.
        page=open_page(browser)
        add_done(page)
        page.wait_for_timeout(400)
        page.evaluate("document.querySelector('[role=status]').textContent='Running'")
        page.wait_for_timeout(400)
        show_stop(page)
        run=page.evaluate("""() => {let x;listener({type:'GET_STATUS'}, {}, r=>x=r);return x.startedAt;}""")
        page.evaluate("""() => {
          document.querySelector('[data-testid=stop-button]').remove();
          document.querySelector('[role=status]').textContent='Completed';
        }""")
        page.wait_for_function("messages.some(x=>x.completionConfirmed)",timeout=8500)
        successes=page.evaluate("messages.filter(x=>x.completionConfirmed)")
        assert len(successes)==1 and successes[0]['completedRunStartedAt']==run,successes
        print('PASS: reused status node Completed -> Running -> Completed is a fresh completion',flush=True)
        page.close()
    finally:
        browser.close()
