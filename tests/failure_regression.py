"""Independent Chromium regression cases for late failures and stale banners."""
from pathlib import Path
import os
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
HTML = """<!doctype html><html lang='ja'><head><link rel='icon' href='/original.ico'></head>
<body><main><form data-chatgpt-composer><textarea id='prompt-textarea'></textarea>
<button type='submit'>Send</button></form></main></body></html>"""


def new_page(browser):
    page = browser.new_page()
    page.set_content(HTML)
    page.evaluate("""() => {
       window.updates=[];
       window.chrome={runtime:{getURL:p=>'https://example.invalid/'+p,
         sendMessage:async m=>{updates.push(m)},onMessage:{addListener:f=>window.listener=f}},
         storage:{local:{get:(d,f)=>f({enabled:true})},onChanged:{addListener:f=>window.change=f}}};
    }""")
    for p in ['src/detector.js', 'src/error-detection.js', 'src/content.js']:
        page.add_script_tag(path=str(ROOT / p))
    page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')")
    return page


def icon(page):
    return page.evaluate("document.querySelector('#chatgpt-tab-pulse-icon')?.href.split('/').pop()")


def status(page):
    return page.evaluate("""() => {let x;listener({type:'GET_STATUS'}, {}, r=>x=r);return x;}""")


def stop(page, add):
    if add:
        page.evaluate("""() => {let b=document.createElement('button');b.type='button';
          b.dataset.testid='stop-button';b.textContent='Stop';document.querySelector('main form').appendChild(b)}""")
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('thinking-32.png')")
    else:
        page.evaluate("document.querySelector('[data-testid=stop-button]').remove()")


def alert(page, marker, msg='Request timed out'):
    page.evaluate("""({marker,msg}) => {let x=document.createElement('div');x.id=marker;
      x.setAttribute('role','alert');x.textContent=msg;document.querySelector('main').appendChild(x)}""", {'marker':marker,'msg':msg})


with sync_playwright() as p:
    browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or '/usr/bin/chromium',headless=True,args=['--no-sandbox'])
    try:
        # Case 1: completion is NOT confirmed after idle debounce; late error wins.
        page=new_page(browser)
        stop(page, True)
        run=status(page)['startedAt']
        stop(page, False)
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('idle-32.png')",timeout=4000)
        page.wait_for_timeout(350)
        assert not any(u.get('completionConfirmed') for u in page.evaluate('updates')), 'premature success broadcast'
        alert(page,'late')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=3500)
        assert not any(u.get('completionConfirmed') for u in page.evaluate('updates')), 'success/timeout conflict'
        assert status(page)['failureRunStartedAt']==run
        print('PASS: late timeout overrides provisional idle; no misleading success notice')
        page.close()

        # Case 2: React node replacement at +95 s keeps same confirmed failure.
        page=new_page(browser)
        stop(page,True)
        alert(page,'first')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=3500)
        page.evaluate("""() => {window.oldDateNow=Date.now; Date.now=()=>oldDateNow()+95000;}""")
        page.wait_for_timeout(3400)
        page.evaluate("document.querySelector('#first').remove()")
        page.wait_for_timeout(500)  # one intermediate evaluation without the DOM node
        alert(page,'second')
        page.wait_for_timeout(500)
        assert icon(page)=='timeout-32.png',f'failed to preserve error across DOM replacement: {icon(page)}'
        assert status(page)['errorKind']=='timeout'
        print('PASS: DOM node replaced after 95s preserves explicit timeout')
        page.close()

        # Case 3: old banner remains first in document order; new live banner wins.
        page=new_page(browser)
        alert(page,'old')
        page.wait_for_timeout(450)
        stop(page,True)
        page.wait_for_timeout(300)
        alert(page,'new')
        page.wait_for_function("document.querySelector('#chatgpt-tab-pulse-icon')?.href.includes('timeout-32.png')",timeout=3500)
        assert status(page)['errorKind']=='timeout'
        print('PASS: newer current-run error chosen over old visible error')
        page.close()

        # Case 4: normal completed run after 5s eventually signals once.
        page=new_page(browser)
        stop(page,True)
        run=status(page)['startedAt']
        stop(page,False)
        page.wait_for_function("updates.some(x=>x.completionConfirmed)",timeout=8000)
        completes=[u for u in page.evaluate('updates') if u.get('completionConfirmed')]
        assert len(completes)==1 and completes[0]['completedRunStartedAt']==run, completes
        print('PASS: settled success sends one completion notification')
        page.close()
    finally:
        browser.close()
