/* opSHion: anonymous room participation. Class results live on the server; this device keeps only its own contribution. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); }, catalog = [], current, result, code = '', sending = false, dirty = false, pending;
  var KEY = 'opshion.v1', store;
  try { store = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
  if (!store || typeof store !== 'object') store = {};
  if (!store.device || !/^[a-f0-9]{36}$/.test(store.device)) store.device = Array.from(crypto.getRandomValues(new Uint8Array(18)), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  if (!store.keys || typeof store.keys !== 'object') store.keys = {};
  if (!store.mine || typeof store.mine !== 'object') store.mine = {};
  function keep() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (_) {} }
  keep();
  function error(text) { $('global-error').textContent = text || ''; $('global-error').hidden = !text; }
  async function api(path, body) {
    var opt = { cache: 'no-store', headers: {} };
    if (body !== undefined) { opt.method = 'POST'; opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    var r = await fetch('/api/' + path, opt), j;
    try { j = await r.json(); } catch (_) { throw new Error('The room is unavailable. Please try again.'); }
    if (!r.ok) throw new Error(j.error || 'Could not reach the room.');
    return j;
  }
  function mineKey() { return code + ':' + current.id; }
  function own() { return store.mine[mineKey()]; }
  function linkFor(roomCode, id) { var u = new URL('/', location.origin); u.searchParams.set('code', roomCode); u.searchParams.set('activity', id); return u.href; }
  function endpoint(roomCode, a) { return 'classdata/' + (a.kind === 'tally' ? 'tallies' : 'values') + '?code=' + roomCode + '&topic=' + encodeURIComponent(a.id); }
  function setSave(text, bad) { $('save-status').textContent = text; $('save-status').style.color = bad ? '#942b16' : ''; }
  async function create(id) {
    error('');
    document.querySelectorAll('#start,.activity').forEach(function (b) { b.disabled = true; });
    try {
      var j = await api('classdata/class', {});
      store.keys[j.code] = j.teacherKey; keep();
      location.href = linkFor(j.code, id);
    } catch (e) { error(e.message); document.querySelectorAll('#start,.activity').forEach(function (b) { b.disabled = false; }); }
  }
  async function join(event) {
    event.preventDefault();
    var c = $('join-code').value.trim().toUpperCase();
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(c)) { error('A class code has six letters and digits. Check the code and try again.'); return; }
    var a = catalog[0];
    try { await api(endpoint(c, a)); location.href = linkFor(c, a.id); } catch (e) { error(e.message); }
  }
  function saveOwn(value) { store.mine[mineKey()] = value; keep(); }
  function makeButton(text, action, cls) { var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls || ''; b.onclick = action; return b; }
  function addTosses(n) {
    if (current.id !== 'coin-sim') return;
    var counts = (own() || [0, 0]).slice(), total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (total + n > current.maxTotal) { setSave('This device can contribute up to ' + current.maxTotal + ' tosses. Clear yours to start again.', true); return; }
    var bytes = new Uint8Array(n); crypto.getRandomValues(bytes);
    bytes.forEach(function (b) { counts[b & 1]++; });
    saveOwn(counts);
    $('toss-face').textContent = bytes[n - 1] & 1 ? 'T' : 'H';
    $('toss-face').classList.add('tossing');
    setTimeout(function () { $('toss-face').classList.remove('tossing'); }, 180);
    updateOwnCounts(); queueSave();
  }
  function updateOwnCounts() {
    var counts = own() || current.outcomes.map(function () { return 0; });
    counts.forEach(function (n, i) { var e = $('count-' + i); if (e) e.value = n; });
  }
  function validCounts() {
    var counts = current.outcomes.map(function (_, i) { var raw = $('count-' + i).value; return /^\d+$/.test(raw) ? Number(raw) : NaN; });
    if (counts.some(function (n) { return !Number.isSafeInteger(n) || n < 0; }) || counts.reduce(function (a, b) { return a + b; }, 0) > current.maxTotal) {
      setSave('Enter nonnegative whole counts, totaling at most ' + current.maxTotal + '.', true); return null;
    }
    return counts;
  }
  function queueSave() {
    clearTimeout(pending); dirty = true; $('retry').hidden = true; setSave('Sending your contribution…');
    pending = setTimeout(send, 300);
  }
  async function send() {
    if (sending) return;
    sending = true; dirty = false;
    var a = current, c = code, value = own();
    try {
      await api('classdata/' + (a.kind === 'tally' ? 'tally' : 'value'), Object.assign({ code: c, topic: a.id, device: store.device }, a.kind === 'tally' ? { counts: value } : { value: value }));
      if (!dirty) { setSave('✓ Your contribution is in the class pool.'); $('retry').hidden = true; }
      await refresh();
    } catch (e) { setSave('Saved on this device. Not sent: ' + e.message, true); $('retry').hidden = false; }
    finally { sending = false; if (dirty) send(); }
  }
  function entry(a) {
    var root = $('entry'); root.textContent = '';
    if (a.kind === 'tally') {
      if (a.id === 'coin-sim') {
        var stage = document.createElement('div'); stage.className = 'toss-stage';
        var face = document.createElement('div'); face.id = 'toss-face'; face.className = 'toss-coin'; face.textContent = '?'; face.setAttribute('aria-label', 'Last virtual coin result'); stage.appendChild(face); root.appendChild(stage);
        var actions = document.createElement('div'); actions.className = 'toss-actions'; actions.appendChild(makeButton('Toss a coin ↗', function () { addTosses(1); }, 'primary')); root.appendChild(actions);
        var batch = document.createElement('div'); batch.className = 'batch'; [10, 100].forEach(function (n) { batch.appendChild(makeButton('+' + n + ' tosses', function () { addTosses(n); })); }); root.appendChild(batch);
      }
      var fields = document.createElement('div'); fields.className = 'counts';
      a.outcomes.forEach(function (outcome, i) {
        var l = document.createElement('label'); l.textContent = outcome;
        var input = document.createElement('input'); input.id = 'count-' + i; input.type = 'number'; input.min = 0; input.max = a.maxTotal; input.step = 1; input.inputMode = 'numeric'; input.readOnly = a.id === 'coin-sim';
        l.appendChild(input); fields.appendChild(l);
      }); root.appendChild(fields); updateOwnCounts();
      if (a.id !== 'coin-sim') {
        var taps = document.createElement('div'); taps.className = 'batch'; taps.style.flexWrap = 'wrap';
        a.outcomes.forEach(function (outcome, i) { taps.appendChild(makeButton('+ ' + outcome, function () { var counts = validCounts(); if (!counts) return; counts[i]++; if (counts.reduce(function (x, y) { return x + y; }, 0) > a.maxTotal) { setSave('This device has reached the maximum number of observations.', true); return; } saveOwn(counts); updateOwnCounts(); queueSave(); })); }); root.appendChild(taps);
        root.appendChild(makeButton('Send my counts ↗', function () { var c = validCounts(); if (c) { saveOwn(c); queueSave(); } }, 'primary'));
      }
      root.appendChild(makeButton('Clear my contributions', function () { if (!confirm('Remove all of this device’s observations from this activity?')) return; saveOwn(a.outcomes.map(function () { return 0; })); updateOwnCounts(); queueSave(); }, 'text-link reset'));
    } else {
      var form = document.createElement('form'); form.className = 'data-form';
      var label = document.createElement('label'); label.htmlFor = 'my-value'; label.textContent = 'Your value · ' + a.label;
      var input = document.createElement('input'); input.id = 'my-value'; input.type = 'number'; input.inputMode = 'numeric'; input.min = a.min; input.max = a.max; input.step = 1; input.required = true; if (own() !== undefined) input.value = own();
      var button = makeButton('Send my value ↗', null, 'primary'); button.type = 'submit';
      form.append(label, input, button); form.onsubmit = function (e) { e.preventDefault(); var v = Number(input.value); if (!Number.isInteger(v) || v < a.min || v > a.max) { setSave('Enter a whole number from ' + a.min + ' to ' + a.max + '.', true); return; } saveOwn(v); queueSave(); }; root.appendChild(form);
      var note = document.createElement('p'); note.className = 'fine'; note.textContent = 'Whole numbers from ' + a.min + ' to ' + a.max + '. Prefer not to share? You can simply observe.'; root.appendChild(note);
    }
    if (own() !== undefined) setSave('Your previous contribution is saved on this device. You can update it.');
  }
  function bar(label, n, total) {
    var row = document.createElement('div'); row.className = 'bar-row';
    var line = document.createElement('div'); line.className = 'bar-label';
    var name = document.createElement('span'); name.textContent = label;
    var count = document.createElement('span'); count.textContent = n + (total ? ' · ' + (100 * n / total).toFixed(1) + '%' : ''); line.append(name, count);
    var track = document.createElement('div'); track.className = 'bar-track';
    var fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = (total ? 100 * n / total : 0) + '%'; track.appendChild(fill); row.append(line, track); return row;
  }
  function draw() {
    var a = current, j = result, chart = $('chart'); chart.textContent = '';
    var n = a.kind === 'tally' ? j.total : j.n;
    $('total').textContent = n; $('participants').textContent = a.kind === 'tally' ? j.devices : j.n;
    $('total-label').textContent = a.kind === 'tally' ? a.id === 'coin-sim' ? 'simulated tosses' : 'observations' : 'shared values';
    $('mean-stat').hidden = a.kind !== 'value';
    if (a.kind === 'tally') a.outcomes.forEach(function (label, i) { chart.appendChild(bar(label, j.counts[i], n)); });
    else if (n) {
      $('mean').textContent = (j.values.reduce(function (x, y) { return x + y; }, 0) / n).toFixed(1);
      var low = Math.min.apply(null, j.values), high = Math.max.apply(null, j.values), width = Math.max(1, Math.ceil((high - low + 1) / 6));
      for (var start = low; start <= high; start += width) { var end = start + width - 1; chart.appendChild(bar(start === end ? String(start) : start + '–' + end, j.values.filter(function (v) { return v >= start && v <= end; }).length, n)); }
    } else { $('mean').textContent = '—'; var empty = document.createElement('p'); empty.className = 'empty-chart'; empty.textContent = 'Your class’s first value will start the picture.'; chart.appendChild(empty); }
    $('result-note').textContent = n ? a.source + ' · Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. Every device adds its own part.' : 'Waiting for the first contribution. Yours could be first.';
  }
  async function refresh() {
    try { result = await api(endpoint(code, current)); draw(); $('room-connection').textContent = 'Room connected'; }
    catch (e) { $('room-connection').textContent = 'Reconnecting…'; $('result-note').textContent = 'Showing the last results. ' + e.message; }
  }
  function share() {
    var link = linkFor(code, current.id);
    $('share-link').value = link; $('share-code').textContent = code; $('share-prompt').textContent = current.prompt; $('copy-status').textContent = '';
    try { var g = qrcode(0, 'M'); g.addData(link); g.make(); $('qr').innerHTML = g.createSvgTag({ cellSize: 4, margin: 16, scalable: true }); }
    catch (_) { $('qr').textContent = 'QR unavailable. Share the student link below.'; }
    $('share-dialog').showModal();
  }
  async function init() {
    catalog = await api('catalog');
    var icons = ['◒', '◐', '⌁', '↥', '↗', '⚄', '◑'];
    catalog.forEach(function (a, i) {
      var card = makeButton('', function () { create(a.id); }, 'activity');
      var icon = document.createElement('span'); icon.className = 'activity-icon'; icon.textContent = icons[i]; icon.setAttribute('aria-hidden', 'true');
      var text = document.createElement('div'); var h = document.createElement('h3'); h.textContent = a.title; var desc = document.createElement('p'); desc.textContent = a.prompt; text.append(h, desc);
      var bottom = document.createElement('div'); bottom.className = 'activity-bottom'; var source = document.createElement('span'); source.textContent = a.source.toUpperCase(); var arrow = document.createElement('span'); arrow.textContent = 'START A ROOM ↗'; bottom.append(source, arrow); card.append(icon, text, bottom); $('activity-grid').appendChild(card);
      var option = document.createElement('option'); option.value = a.id; option.textContent = a.title; $('activity-select').appendChild(option);
    });
    $('start').onclick = function () { create(catalog[0].id); }; $('join-form').onsubmit = join;
    var q = new URLSearchParams(location.search); code = (q.get('code') || '').trim().toUpperCase();
    if (!code) return;
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) throw new Error('That class code is not valid. Check the link or enter your teacher’s code.');
    current = catalog.find(function (a) { return a.id === q.get('activity'); }) || catalog[0];
    result = await api(endpoint(code, current));
    $('home').hidden = true; $('room').hidden = false;
    $('room-code').textContent = code; $('room-title').textContent = current.title; $('room-prompt').textContent = current.prompt; $('room-source').textContent = current.source.toUpperCase() + ' / ' + current.label.toUpperCase();
    $('teacher-note').hidden = !store.keys[code]; $('activity-select').value = current.id;
    $('activity-select').onchange = function () { if (sending || dirty || !$('retry').hidden) { error('Send your pending contribution before switching activities.'); $('activity-select').value = current.id; return; } location.href = linkFor(code, this.value); };
    entry(current); draw(); $('room-connection').textContent = 'Room connected';
    $('retry').onclick = function () { dirty = true; send(); };
    $('share').onclick = share; $('close-share').onclick = function () { $('share-dialog').close(); };
    $('copy-link').onclick = async function () { try { await navigator.clipboard.writeText($('share-link').value); $('copy-status').textContent = 'Student link copied.'; } catch (_) { $('share-link').focus(); $('share-link').select(); $('copy-status').textContent = 'Select and copy the student link above.'; } };
    $('export').onclick = function () {
      var rows = current.kind === 'tally' ? [['outcome', 'count'], ...current.outcomes.map(function (l, i) { return [l, result.counts[i]]; })] : [['value'], ...result.values.map(function (v) { return [v]; })];
      var blob = new Blob([rows.map(function (row) { return row.join(','); }).join('\n') + '\n'], { type: 'text/csv;charset=utf-8' }); var u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = 'opSHion-' + code + '-' + current.id + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    };
    setInterval(function () { if (!document.hidden) refresh(); }, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('beforeunload', function (e) { if (sending || dirty) { e.preventDefault(); e.returnValue = ''; } });
    if (store.keys[code] && !sessionStorage.getItem('opshion.shared.' + code)) { sessionStorage.setItem('opshion.shared.' + code, '1'); share(); }
  }
  init().catch(function (e) { error(e.message || 'Could not connect. Please reload to try again.'); });
})();
