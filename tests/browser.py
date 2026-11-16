"""Two independent students, real API+SQLite, QR decoding, mobile, and CSV export."""
import csv
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
        expect(page.locator('.activity')).to_have_count(31)
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
        def select_activity(activity):
            s.locator('#activity-select').select_option(activity)
            expect(s.locator('#activity-select')).to_have_value(activity)

        def submit_answers():
            s.get_by_role('button', name='Send my answers', exact=False).click()
            expect(s.locator('#save-status')).to_contain_text('in the class pool')

        def pool(topic, field=None, records=False):
            path = '/api/classdata/' + ('records' if records else 'values') + '?code=' + code + '&topic=' + topic
            if field: path += '&field=' + field
            response = s.request.get(base + path)
            assert response.ok, response.text()
            return response.json()

        # All field kinds submit through the real Worker and its SQLite database.
        select_activity('alphabet')
        s.locator('#field-how').select_option('1')
        s.locator('#field-tries').fill('2')
        s.locator('#field-seconds').fill('5.83')
        submit_answers()
        assert pool('alphabet', 'seconds')['values'] == [5.83]
        expect(s.locator('#chart')).to_contain_text('sang it')
        expect(s.locator('#chart')).to_contain_text('5.83')
        # A later question may update one field without erasing an earlier answer.
        s.locator('#field-how').select_option('')
        s.locator('#field-seconds').fill('')
        s.locator('#field-tries').fill('3')
        submit_answers()
        assert pool('alphabet', 'tries')['values'] == [3]
        assert pool('alphabet', 'seconds')['values'] == [5.83]
        s.reload()
        expect(s.locator('#field-seconds')).to_have_value('5.83')

        select_activity('sleep')
        s.locator('#field-wakes').select_option('0')
        s.locator('#field-sleepy').select_option('2')
        s.locator('#field-wake').fill('06:45')
        s.locator('#field-hours').fill('7.5')
        s.locator('#field-weekend').fill('09:30')
        submit_answers()
        assert pool('sleep', 'wake')['values'] == [405]
        assert pool('sleep', 'hours')['values'] == [7.5]
        expect(s.locator('#chart')).to_contain_text('06:45')
        expect(s.locator('#chart')).to_contain_text('09:30')
        assert s.request.get(base + '/api/classdata/records?code=' + code + '&topic=sleep').status == 403
        with s.expect_download() as dl:
            s.locator('#export').click()
        sleep_rows = list(csv.reader(pathlib.Path(dl.value.path()).read_text().splitlines()))
        assert sleep_rows[0] == ['question', 'value']
        assert ['Wake time on a school day', '06:45'] in sleep_rows
        assert ['Hours of sleep on a school night, to the nearest half hour', '7.5'] in sleep_rows

        # Assignment stays on the server. Each student sees only their own prompt
        # and cannot open the class comparison through this UI before submitting.
        anchor_reads = []
        s.on('request', lambda request: anchor_reads.append(request.url) if '/classdata/records' in request.url else None)
        select_activity('anchor')
        expect(s.locator('#assigned-prompt')).to_be_visible()
        assigned_prompt = s.locator('#assigned-prompt').inner_text()
        assert ('1,500' in assigned_prompt) != ('6,000' in assigned_prompt)
        other_number = '6,000' if '1,500' in assigned_prompt else '1,500'
        assert other_number not in s.locator('body').inner_text()
        expect(s.locator('#total')).to_have_text('—')
        expect(s.locator('#export')).to_be_hidden()
        assert not anchor_reads
        anchor_context = browser.new_context(viewport={'width': 390, 'height': 844})
        contexts.append(anchor_context)
        other = anchor_context.new_page()
        other.goto(base + '/?code=' + code + '&activity=anchor')
        expect(other.locator('#assigned-prompt')).to_be_visible()
        assert other.locator('#assigned-prompt').inner_text() != assigned_prompt
        expect(other.locator('#export')).to_be_hidden()
        s.locator('#field-trip').select_option('1')
        s.locator('#field-guess').fill('3200')
        submit_answers()
        expect(s.locator('#export')).to_be_visible()
        expect(s.locator('#chart')).to_contain_text('Guesses by assigned group')
        other.locator('#field-guess').fill('2800')
        other.get_by_role('button', name='Send my answers', exact=False).click()
        expect(other.locator('#save-status')).to_contain_text('in the class pool')
        s.reload()
        expect(s.locator('#assigned-prompt')).to_have_text(assigned_prompt)
        assert other_number not in s.locator('body').inner_text()
        anchor_pool = pool('anchor', records=True)
        assert anchor_pool['n'] == 2 and 'ids' not in anchor_pool
        assert sorted(row[0] for row in anchor_pool['rows']) == [0, 1]

        select_activity('planes')
        s.locator('#field-metres').fill('4.3')
        submit_answers()
        assert pool('planes', 'metres')['values'] == [4.3]
        expect(s.locator('#chart')).to_contain_text('4.3')
        with s.expect_download() as dl:
            s.locator('#export').click()
        assert '4.3' in pathlib.Path(dl.value.path()).read_text()

        select_activity('trip')
        s.locator('#field-way').select_option('2')
        s.locator('#field-minutes').fill('18')
        submit_answers()
        assert pool('commute')['values'] == [18]
        s.locator('#field-way').select_option('')
        s.locator('#field-minutes').fill('20')
        submit_answers()
        trip_pool = pool('trip', records=True)
        assert trip_pool['rows'] == [[2, 20]] and 'ids' not in trip_pool
        expect(s.locator('#chart')).to_contain_text('walk or bike: 1 answers · mean 20.0 minutes')
        with s.expect_download() as dl:
            s.locator('#export').click()
        trip_rows = list(csv.reader(pathlib.Path(dl.value.path()).read_text().splitlines()))
        assert trip_rows[1] == ['walk or bike', '20']

        # Generic tally activities accept only real observed counts. CSV outcome
        # labels containing a comma must remain one cell.
        select_activity('s34-survey')
        expect(s.locator('#toss-face')).to_have_count(0)
        s.locator('#count-0').fill('2')
        s.get_by_role('button', name='Send my counts', exact=False).click()
        expect(s.locator('#save-status')).to_contain_text('in the class pool')
        with s.expect_download() as dl:
            s.locator('#export').click()
        tally_rows = list(csv.reader(pathlib.Path(dl.value.path()).read_text().splitlines()))
        assert tally_rows[1] == ['Outside, Ninth', '2']

        # Combined pages write the original registry topics, so book simulators
        # and individual activity pages read the same contributions.
        for activity, values in [('pulse-commute', {'pulse': '74', 'commute': '22'}), ('height-pulse', {'height': '170', 'pulse': '76'}), ('playlist', {'s62-song': '3', 's62-run4': '17'})]:
            select_activity(activity)
            for topic, value in values.items(): s.locator('#field-' + topic).fill(value)
            submit_answers()
            for topic, value in values.items(): assert pool(topic)['values'] == [int(value)]
            assert not s.evaluate('document.documentElement.scrollWidth > innerWidth')
        select_activity('pulse')
        expect(s.locator('#my-value')).to_have_value('76')
        select_activity('trip')
        expect(s.locator('#field-minutes')).to_have_value('22')

        # Invalid codes show a useful error and keep the home entry flow available.
        s.goto(base + '/?code=AAAAAA')
        expect(s.locator('#global-error')).to_contain_text('No class')
        assert not errors, errors
        for c in contexts: c.close()
        teacher.close()
        browser.close()
    print('PASS: QR, independent devices, numeric updates, alphabet/sleep/anchor/planes/trip forms, partial records, server assignment privacy, generic real tallies, paired activities, safe CSV, mobile fit, invalid code.')
finally:
    server.terminate()
    server.wait(timeout=10)
