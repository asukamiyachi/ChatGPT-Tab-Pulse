"""Edge cases: stale banner mutation, Retry controls, task status, same-frame failure.

These tests deliberately use mock DOM; they are not live ChatGPT / Work E2E tests.
"""
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """<!doctype html><html><head><link rel='icon' href='/original.ico'></head>
<body><main><form data-chatgpt-composer><textarea id='prompt-textarea'></textarea>
<button type='submit'>Send</button></form></main></body></html>"""


def page_with_extension(browser):
    page = browser.new_page()
    page.set_content(HTML)
    page.evaluate("""() => {window.updates=[];window.chrome={
      runtime:{getURL:p=>'https://example.invalid/'+p,
        sendMessage:async x=>{updates.push(x)},onMessage:{addListener:f=>window.listener=f}},
      storage:{local:{get:(d,f)=>f({enabled:true})},onChanged:{addListener:()=>{}}}};}""")
    for f in ('src/detector.js', 'src/error-detection.js', 'src/content.js'):
        page.add_script_tag(path=str(ROOT / f))
    page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')")
    return page


def state(page, name, timeout=5000):
    page.wait_for_function(f"document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('{name}-32.png')", timeout=timeout)


def add_stop(page):
    page.evaluate("""() => {const b=document.createElement('button');b.type='button';
      b.dataset.testid='stop-button';b.textContent='Stop';document.querySelector('main form').appendChild(b)}""")
    state(page, 'thinking')


def add_error(page, name='error', text='Request timed out', attrs=None):
    page.evaluate("""({name,text,attrs}) => {
      const e=document.createElement('div');e.id=name;e.setAttribute('role','alert');e.textContent=text;
      for (const [k,v] of Object.entries(attrs||{}))e.setAttribute(k,v);
      document.querySelector('main').appendChild(e)
    }""", {'name':name,'text':text,'attrs':attrs})


with sync_playwright() as p:
    browser = p.chromium.launch(
        executable_path=os.environ.get('CHROMIUM_PATH') or
        ('/usr/bin/chromium' if Path('/usr/bin/chromium').exists() else None),
        headless=True,args=['--no-sandbox'])
    try:
        # The stale error node must retain its *original* age if only its text changes.
        page = page_with_extension(browser)
        add_error(page, 'old')
        page.wait_for_timeout(400)
        add_stop(page)
        page.evaluate("document.querySelector('#old').textContent='Timeout'")
        page.wait_for_timeout(1600)
        assert page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon').href.includes('thinking-32.png')")
        print('PASS: old timeout banner text mutation is not a new run error', flush=True)
        # A new banner can still be detected despite the older one.
        add_error(page, 'new')
        state(page, 'timeout')
        print('PASS: new timeout is preferred over a mutated old banner', flush=True)
        page.close()

        # The Retry control is not part of the message text.
        page = page_with_extension(browser)
        add_stop(page)
        page.evaluate("""() => {const a=document.createElement('div');a.id='failure';
          a.setAttribute('role','alert');const m=document.createElement('span');
          m.textContent='Something went wrong';a.appendChild(m);
          const b=document.createElement('button');b.textContent='Retry';a.appendChild(b);
          document.querySelector('main').appendChild(a)}""")
        state(page,'error')
        print('PASS: retry button no longer masks visible generation failure',flush=True)
        page.close()

        # Failed machine-readable task state and visible description are independent.
        page = page_with_extension(browser)
        add_stop(page)
        page.evaluate("""() => {const a=document.createElement('div');a.id='task';
          a.setAttribute('data-task-status','failed');a.textContent='Task failed';
          document.querySelector('main').appendChild(a)}""")
        state(page,'error')
        print('PASS: failed task status and Task failed message detected',flush=True)
        page.close()

        # Even if the UI has only a failed task attr, the task failure is meaningful.
        page = page_with_extension(browser)
        add_stop(page)
        page.evaluate("""() => {const a=document.createElement('div');
          a.setAttribute('data-task-status','failed');document.querySelector('main').appendChild(a)}""")
        state(page,'error')
        print('PASS: machine-readable failed state detected',flush=True)
        page.close()

        # Start and error may arrive during one MutationObserver delivery.
        page = page_with_extension(browser)
        page.evaluate("""() => {const main=document.querySelector('main');
          const b=document.createElement('button');b.type='button';b.dataset.testid='stop-button';
          b.textContent='Stop';main.querySelector('form').appendChild(b);
          const a=document.createElement('div');a.id='same-frame';a.setAttribute('role','alert');
          a.textContent='Request timed out';main.appendChild(a)}""")
        state(page,'timeout')
        info=page.evaluate("""() => {let v;listener({type:'GET_STATUS'}, {}, r=>v=r);return v;}""")
        assert info['failureRunStartedAt'], info
        print('PASS: co-observed strong run evidence and timeout classified',flush=True)
        page.close()
    finally:
        browser.close()
