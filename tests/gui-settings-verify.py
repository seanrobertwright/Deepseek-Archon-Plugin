"""Verify the Archon settings page renders in DSH's live Settings shell.

Mints the browser-session cookie (same construction as gui-e2e.mjs), opens a
session so the settings trigger is usable, clicks the sidebar-foot settings
trigger, selects the 'Archon' nav section, and asserts the mirrored Archon
server settings render: Server & System (health/concurrency), Assistant
Configuration (default assistant select + provider editors), Platform
Connections badges, and Projects. Read-only — no writes to the Archon server.

Run: python tests/gui-settings-verify.py   (live dsh web GUI + Archon server)
"""
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

        # Open a session so the sidebar footer (with the settings trigger) is
        # in its wide state and onboarding overlays are gone.
        tree = page.query_selector('[role="treeitem"]')
        if not tree:
            print('WARN: no session tree found; proceeding without opening one')
        else:
            tree.click()
            time.sleep(6)

        # Sidebar-foot settings trigger: button that opens the dialog.
        trigger = page.locator('button[aria-haspopup="dialog"]').first
        trigger.wait_for(state='visible', timeout=15000)
        trigger.click()
        time.sleep(3)

        # Nav cell for our section (label 'Archon').
        nav_btn = page.locator('nav button', has_text='Archon').first
        nav_btn.wait_for(state='visible', timeout=10000)
        nav_btn.click()
        time.sleep(6)

        root = page.query_selector('.dsha-settings')
        checks = {
            'Archon settings root rendered (.dsha-settings)': root is not None,
        }
        text = ''
        if root:
            text = root.inner_text()
            checks['Server & System card'] = 'Server & System' in text
            checks['Assistant Configuration card'] = 'Assistant Configuration' in text
            checks['default assistant select rendered'] = root.query_selector('#dsha-default-assistant') is not None
            checks['Platform Connections card'] = 'Platform Connections' in text
            checks['Projects card'] = 'Projects' in text
            checks['add project affordance'] = 'Add project' in text
            checks['server status ok text'] = 'ok' in text and 'concurrent' in text
            checks['no unreachable banner'] = 'unreachable' not in text.lower()
            print('--- settings text (first 900) ---')
            print(text[:900].replace('\n', ' | '))
        for label, passed in checks.items():
            print(('PASS: ' if passed else 'FAIL: ') + label)
            ok = ok and passed
        print('errors:', errs[:8])
        ok = ok and len(errs) == 0
        Path('artifacts').mkdir(exist_ok=True)
        page.screenshot(path='artifacts/40-settings-archon.png')
        b.close()

    print('RESULT:', 'PASS' if ok else 'FAIL')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
