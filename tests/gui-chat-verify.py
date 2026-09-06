"""Verify the Archon Chat mode (M2) renders in the live GUI."""
import base64
import hashlib
import hmac
import json
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright


def b64url(d): return base64.urlsafe_b64encode(d).decode().rstrip('=')
def b64d(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


def main():
    yaml = (Path.home() / '.dsh' / '.credentials.yaml').read_text(encoding='utf-8')
    sec = b64d(re.search(r'client-connection/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)', yaml).group(1))
    A = '127.0.0.1:3080'
    name = 'dsh-auth-' + b64url(hashlib.sha256(A.encode()).digest())
    now = int(time.time() * 1000)
    body = b64url(json.dumps({'version': 1, 'authority': A, 'issuedAt': now, 'expiresAt': now + 86400000}).encode())
    sig = b64url(hmac.new(sec, body.encode(), hashlib.sha256).digest())
    cookie = {'name': name, 'value': f'v1.{body}.{sig}', 'domain': '127.0.0.1', 'path': '/'}

    ok = True
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={'width': 1500, 'height': 940})
        ctx.add_cookies([cookie])
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text[:200]) if m.type == 'error' else None)
        page.goto('http://127.0.0.1:3080/', wait_until='domcontentloaded', timeout=30000)
        time.sleep(8)
        page.locator('[role="treeitem"]').nth(2).click()
        time.sleep(6)
        page.evaluate("() => window.dispatchEvent(new CustomEvent('dsh:conversation.open-view',{detail:{view:'archon'}}))")
        time.sleep(8)

        view = page.query_selector('.dsha-view')
        if not view:
            print('FAIL: no .dsha-view')
            ok = False
        else:
            # Click the Chat mode toggle (the second .dsha-mode button).
            modes = page.query_selector_all('.dsha-mode')
            chat_btn = None
            for m in modes:
                if m.inner_text().strip() == 'Chat':
                    chat_btn = m
            if not chat_btn:
                print('FAIL: Chat mode toggle not found')
                ok = False
            else:
                chat_btn.evaluate("el => el.click()")
                print('clicked Chat mode toggle (js)')
                time.sleep(8)
                chat = page.query_selector('.dsha-chat')
                checks = {
                    'chat pane rendered (.dsha-chat)': chat is not None,
                }
                if chat:
                    t = chat.inner_text()
                    checks['Conversations heading'] = 'CONVERSATIONS' in t or 'conversations' in t.lower()
                    checks['New conversation button'] = 'New conversation' in t
                    checks['conversation rows loaded'] = len(chat.query_selector_all('option')) > 0
                    print('--- chat pane text (first 600) ---')
                    print(t[:600].replace('\n', ' | '))
                for label, passed in checks.items():
                    print(('PASS: ' if passed else 'FAIL: ') + label)
                    ok = ok and passed
        print('errors:', errs[:8])
        ok = ok and len(errs) == 0
        Path('artifacts').mkdir(exist_ok=True)
        page.screenshot(path='artifacts/30-chat-mode.png')
        b.close()

    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
