"""Two independent students, real API+SQLite, QR decoding, mobile, and CSV export."""
import io
import json
import pathlib
import subprocess
import urllib.parse
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[1]
server = subprocess.Popen(['node', 'tests/server.mjs'], cwd=ROOT, stdout=subprocess.PIPE, text=True)
try:
    base = server.stdout.readline().strip()
    assert base.startswith('http://127.0.0.1:')
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        teacher = browser.new_context(viewport={'width': 1440, 'height': 1000})
        page = teacher.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(base)
        expect(page.locator('.activity')).to_have_count(7)
        page.locator('#start').click()
        page.locator('#qr svg').wait_for()
        link = page.locator('#share-link').input_value()
        assert 'activity=coin-sim' in link and 'teacher' not in link
        code = urllib.parse.parse_qs(urllib.parse.urlparse(link).query)['code'][0]
        assert len(code) == 6
        import cv2
        import numpy as np
        shot = page.locator('#qr').screenshot()
        image = cv2.imdecode(np.frombuffer(shot, np.uint8), cv2.IMREAD_COLOR)
        decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(image)
        assert decoded == link, 'The displayed QR must decode to the student activity.'
        page.locator('#close-share').click()
        contexts = []
        for count in (100, 10):
            c = browser.new_context(viewport={'width': 390, 'height': 844})
            contexts.append(c)
            s = c.new_page()
            s.goto(link)
            expect(s.locator('#room-title')).to_have_text('Coin toss lab')
            assert not s.locator('#share-dialog').is_visible()
            s.get_by_role('button', name='+' + str(count) + ' tosses', exact=True).click()
            expect(s.locator('#save-status')).to_contain_text('in the class pool')
            assert not s.evaluate("Object.keys(JSON.parse(localStorage.getItem('opshion.v1')).keys).length")
            assert not s.evaluate('document.documentElement.scrollWidth > innerWidth')
        expect(page.locator('#total')).to_have_text('110', timeout=12000)
        expect(page.locator('#participants')).to_have_text('2')
        # Reloading a device preserves its own tally and does not add duplicates.
        s.reload()
        expect(s.locator('#total')).to_have_text('110')
        assert sum(int(s.locator('#count-' + str(i)).input_value()) for i in range(2)) == 10
        # Numeric values use the same room; updating replaces instead of appending.
        s.locator('#activity-select').select_option('pulse')
        expect(s.locator('#room-title')).to_have_text('Resting pulse')
        for v in ('70', '72'):
            s.locator('#my-value').fill(v)
            s.get_by_role('button', name='Send my value').click()
            expect(s.locator('#save-status')).to_contain_text('in the class pool')
        expect(s.locator('#mean')).to_have_text('72.0')
        expect(s.locator('#participants')).to_have_text('1')
        with s.expect_download() as dl:
            s.locator('#export').click()
        assert pathlib.Path(dl.value.path()).read_text() == 'value\n72\n'
        s.locator('#share').click()
        assert 'activity=pulse' in s.locator('#share-link').input_value()
        s.keyboard.press('Escape')
        expect(s.locator('#share-dialog')).not_to_be_visible()
        # Invalid codes show a useful error and keep the home entry flow available.
        s.goto(base + '/?code=AAAAAA')
        expect(s.locator('#global-error')).to_contain_text('No class')
        assert not errors, errors
        for c in contexts: c.close()
        teacher.close()
        browser.close()
    print('PASS: QR decode, fresh-device join, two-student pool, idempotent reload, numeric updates, CSV, mobile fit, invalid code.')
finally:
    server.terminate()
    server.wait(timeout=10)
