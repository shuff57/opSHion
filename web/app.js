/* Anonymous classroom contributions. Only this device's own answers are stored locally. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var catalog = [], current, result, code = '', sending = false, dirty = false, pending, assignment;
  var KEY = 'opshion.v1', store;
  try { store = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) {}
  if (!store || typeof store !== 'object') store = {};
  if (!store.device || !/^[a-f0-9]{36}$/.test(store.device)) store.device = Array.from(crypto.getRandomValues(new Uint8Array(18)), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  ['keys', 'mine', 'sent'].forEach(function (k) { if (!store[k] || typeof store[k] !== 'object') store[k] = {}; });
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
  function own() {
    var value = store.mine[mineKey()];
    if (current.kind === 'bundle') {
      var combined = Object.assign({}, value);
      current.fields.forEach(function (f) { var scalar = store.mine[code + ':' + f.id]; if (scalar !== undefined) combined[f.id] = scalar; });
      return Object.keys(combined).length ? combined : undefined;
    }
    if (current.id === 'trip' && store.mine[code + ':commute'] !== undefined) return Object.assign({}, value, { minutes: store.mine[code + ':commute'] });
    return value;
  }
  function linkFor(roomCode, id) { var u = new URL('/', location.origin); u.searchParams.set('code', roomCode); u.searchParams.set('activity', id); return u.href; }
  function endpoint(roomCode, a, field) { return 'classdata/' + (a.kind === 'tally' ? 'tallies' : 'values') + '?code=' + roomCode + '&topic=' + encodeURIComponent(a.id) + (field ? '&field=' + encodeURIComponent(field) : ''); }
  function setSave(text, bad) { $('save-status').textContent = text; $('save-status').style.color = bad ? '#942b16' : ''; }
  function locked() { return current.randomized && !(store.sent[mineKey()] && store.sent[mineKey()].guess !== undefined); }
  async function readResults() {
    if (locked()) return { locked: true };
    if (current.kind === 'record') {
      if (current.linked) {
        var linked = await api('classdata/records?code=' + code + '&topic=' + encodeURIComponent(current.id));
        linked.series = current.fields.map(function (f) {
          var i = linked.fields.indexOf(f.id), values = linked.rows.map(function (r) { return r[i]; }).filter(function (v) { return v !== null; }).sort(function (a, b) { return a - b; });
          return { field: f, values: values, n: values.length };
        });
        return linked;
      }
      return { series: await Promise.all(current.fields.map(async function (f) { return Object.assign(await api(endpoint(code, current, f.id)), { field: f }); })) };
    }
    if (current.kind === 'bundle') return { series: await Promise.all(current.fields.map(async function (f) { return Object.assign(await api(endpoint(code, { id: f.id })), { field: f }); })) };
    return api(endpoint(code, current));
  }
  async function create(id) {
    error('');
    document.querySelectorAll('#start,.activity').forEach(function (b) { b.disabled = true; });
    try {
      var j = await api('classdata/class', {}); store.keys[j.code] = j.teacherKey; keep(); location.href = linkFor(j.code, id);
    } catch (e) { error(e.message); document.querySelectorAll('#start,.activity').forEach(function (b) { b.disabled = false; }); }
  }
  async function join(event) {
    event.preventDefault(); var c = $('join-code').value.trim().toUpperCase();
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(c)) { error('A class code has six letters and digits. Check the code and try again.'); return; }
    try { await api(endpoint(c, catalog[0])); location.href = linkFor(c, catalog[0].id); } catch (e) { error(e.message); }
  }
  function saveOwn(value) {
    store.mine[mineKey()] = value;
    if (current.kind === 'bundle') current.fields.forEach(function (f) { if (value[f.id] !== undefined) store.mine[code + ':' + f.id] = value[f.id]; });
    if (current.id === 'trip' && value.minutes !== undefined) store.mine[code + ':commute'] = value.minutes;
    keep();
  }
  function makeButton(text, action, cls) { var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls || ''; b.onclick = action; return b; }
  function addTosses(n) {
    if (current.id !== 'coin-sim') return;
    var counts = (own() || [0, 0]).slice(), total = counts.reduce(function (a, b) { return a + b; }, 0);
    if (total + n > current.maxTotal) { setSave('This device can contribute up to ' + current.maxTotal + ' tosses. Clear yours to start again.', true); return; }
    var bytes = new Uint8Array(n); crypto.getRandomValues(bytes); bytes.forEach(function (b) { counts[b & 1]++; }); saveOwn(counts);
    $('toss-face').textContent = bytes[n - 1] & 1 ? 'T' : 'H'; $('toss-face').classList.add('tossing');
    setTimeout(function () { $('toss-face').classList.remove('tossing'); }, 180); updateOwnCounts(); queueSave();
  }
  function updateOwnCounts() { (own() || current.outcomes.map(function () { return 0; })).forEach(function (n, i) { if ($('count-' + i)) $('count-' + i).value = n; }); }
  function validCounts() {
    var counts = current.outcomes.map(function (_, i) { var raw = $('count-' + i).value; return /^\d+$/.test(raw) ? Number(raw) : NaN; });
    if (counts.some(function (n) { return !Number.isSafeInteger(n) || n < 0; }) || counts.reduce(function (a, b) { return a + b; }, 0) > current.maxTotal) { setSave('Enter nonnegative whole counts, totaling at most ' + current.maxTotal + '.', true); return null; }
    return counts;
  }
  function queueSave() { clearTimeout(pending); dirty = true; $('retry').hidden = true; setSave('Sending your contribution…'); pending = setTimeout(send, 300); }
  async function send() {
    if (sending) return;
    sending = true; dirty = false;
    var a = current, c = code, value = own(), body = { code: c, topic: a.id, device: store.device };
    try {
      if (a.kind === 'bundle') {
        for (var f of a.fields) if (value[f.id] !== undefined) await api('classdata/value', Object.assign({}, body, { topic: f.id, value: value[f.id] }));
      } else await api('classdata/' + (a.kind === 'tally' ? 'tally' : a.kind === 'record' ? 'record' : 'value'), Object.assign(body, a.kind === 'tally' ? { counts: value } : a.kind === 'record' ? { values: value } : { value: value }));
      store.sent[mineKey()] = value; keep();
      if (!dirty) { setSave('✓ Your contribution is in the class pool.'); $('retry').hidden = true; }
      await refresh();
    } catch (e) { setSave('Saved on this device. Not sent: ' + e.message, true); $('retry').hidden = false; }
    finally { sending = false; if (dirty) send(); }
  }
  function timeText(minutes) { return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0'); }
  function display(f, value) { return value === null || value === undefined ? '' : f.kind === 'choice' ? f.options[value] : f.kind === 'clock' ? timeText(value) : f.kind === 'decimal' ? Number(value).toFixed(f.places) : String(value); }
  function formInput(f, value) {
    var input = document.createElement(f.kind === 'choice' ? 'select' : 'input'); input.id = 'field-' + f.id;
    if (f.kind === 'choice') {
      var blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose or skip'; input.appendChild(blank);
      f.options.forEach(function (text, i) { var option = document.createElement('option'); option.value = i; option.textContent = text; input.appendChild(option); });
    } else if (f.kind === 'clock') { input.type = 'time'; input.min = timeText(f.min); input.max = timeText(f.max); input.step = (f.step || 5) * 60; }
    else { input.type = 'number'; input.min = f.min; input.max = f.max; input.step = f.step || (f.kind === 'decimal' ? 1 / Math.pow(10, f.places) : 1); input.inputMode = f.kind === 'decimal' ? 'decimal' : 'numeric'; }
    if (value !== undefined) input.value = f.kind === 'clock' ? timeText(value) : value;
    return input;
  }
  function readForm(fields) {
    var values = {};
    for (var f of fields) {
      var input = $('field-' + f.id), raw = input.value;
      if (input.disabled || raw === '') continue;
      var v = f.kind === 'clock' ? Number(raw.slice(0, 2)) * 60 + Number(raw.slice(3, 5)) : Number(raw);
      var step = f.step || (f.kind === 'decimal' ? 1 / Math.pow(10, f.places) : 1);
      if (!Number.isFinite(v) || (f.kind === 'choice' ? !Number.isInteger(v) || v < 0 || v >= f.options.length : v < f.min || v > f.max || Math.abs((v - f.min) / step - Math.round((v - f.min) / step)) > 1e-6)) { setSave('Check your answer for “' + f.label + '”.', true); input.focus(); return null; }
      values[f.id] = v;
    }
    if (!Object.keys(values).length) { setSave('Add at least one answer. You can skip the others.', true); return null; }
    return values;
  }
  async function assignQuestion(button) {
    if (button) button.disabled = true;
    try {
      var j = await api('classdata/assign', { code: code, topic: current.id, device: store.device });
      assignment = j.group; $('assigned-prompt').textContent = j.prompt; $('assigned-prompt').hidden = false;
      current.fields.forEach(function (f) { if (f.afterAssign) $('field-' + f.id).disabled = false; });
      $('assign-question').hidden = true;
    } catch (e) { setSave('Your question could not load: ' + e.message, true); }
    finally { if (button) button.disabled = false; }
  }
  function recordEntry(a, root) {
    var form = document.createElement('form'); form.className = 'data-form record-form';
    var note = document.createElement('p'); note.className = 'fine'; note.textContent = 'Share any answers you choose. Leave a field blank to keep it unchanged. You can also just observe.'; form.appendChild(note);
    a.fields.forEach(function (f) {
      if (f.afterAssign) {
        var prompt = document.createElement('p'); prompt.id = 'assigned-prompt'; prompt.className = 'assigned-prompt'; prompt.hidden = true; form.appendChild(prompt);
        var assign = makeButton('Get my question ↗', function () { assignQuestion(assign); }, 'dark'); assign.id = 'assign-question'; form.appendChild(assign);
      }
      var label = document.createElement('label'); label.htmlFor = 'field-' + f.id; label.textContent = f.label + (f.unit && f.kind !== 'clock' ? ' · ' + f.unit : '');
      var input = formInput(f, (own() || {})[f.id]); if (f.afterAssign) input.disabled = assignment === undefined;
      form.appendChild(label);
      if (a.kind === 'bundle') { var instruction = document.createElement('p'); instruction.className = 'fine'; instruction.textContent = f.prompt; form.appendChild(instruction); }
      form.appendChild(input);
      if (f.kind !== 'choice') { var hint = document.createElement('p'); hint.className = 'field-hint fine'; hint.textContent = f.kind === 'clock' ? 'Use a five-minute step, such as 06:45.' : f.min + ' to ' + f.max + (f.kind === 'int' ? ', whole numbers.' : ', steps of ' + (f.step || 1 / Math.pow(10, f.places)) + '.'); form.appendChild(hint); }
    });
    var submit = makeButton('Send my answers ↗', null, 'primary'); submit.type = 'submit'; form.appendChild(submit);
    form.onsubmit = function (e) { e.preventDefault(); var v = readForm(a.fields); if (v) { saveOwn(Object.assign({}, own(), v)); queueSave(); } }; root.appendChild(form);
    if (a.randomized) assignQuestion($('assign-question'));
  }
  function entry(a) {
    var root = $('entry'); root.textContent = '';
    if (a.kind === 'record' || a.kind === 'bundle') recordEntry(a, root);
    else if (a.kind === 'tally') {
      if (a.id === 'coin-sim') {
        var stage = document.createElement('div'); stage.className = 'toss-stage'; var face = document.createElement('div'); face.id = 'toss-face'; face.className = 'toss-coin'; face.textContent = '?'; face.setAttribute('aria-label', 'Last virtual coin result'); stage.appendChild(face); root.appendChild(stage);
        var actions = document.createElement('div'); actions.className = 'toss-actions'; actions.appendChild(makeButton('Toss a coin ↗', function () { addTosses(1); }, 'primary')); root.appendChild(actions);
        var batch = document.createElement('div'); batch.className = 'batch'; [10, 100].forEach(function (n) { batch.appendChild(makeButton('+' + n + ' tosses', function () { addTosses(n); })); }); root.appendChild(batch);
      } else { var real = document.createElement('p'); real.className = 'fine'; real.textContent = 'Record observations from the real activity. Each tap adds one observed outcome; you can also type batch counts.'; root.appendChild(real); }
      var fields = document.createElement('div'); fields.className = 'counts';
      a.outcomes.forEach(function (outcome, i) { var l = document.createElement('label'); l.textContent = outcome; var input = document.createElement('input'); input.id = 'count-' + i; input.type = 'number'; input.min = 0; input.max = a.maxTotal; input.step = 1; input.inputMode = 'numeric'; input.readOnly = a.id === 'coin-sim'; l.appendChild(input); fields.appendChild(l); }); root.appendChild(fields); updateOwnCounts();
      if (a.id !== 'coin-sim') {
        var taps = document.createElement('div'); taps.className = 'batch'; taps.style.flexWrap = 'wrap';
        a.outcomes.forEach(function (outcome, i) { taps.appendChild(makeButton('+ ' + outcome, function () { var counts = validCounts(); if (!counts) return; counts[i]++; if (counts.reduce(function (x, y) { return x + y; }, 0) > a.maxTotal) { setSave('This device has reached the maximum number of observations.', true); return; } saveOwn(counts); updateOwnCounts(); queueSave(); })); }); root.appendChild(taps);
        root.appendChild(makeButton('Send my counts ↗', function () { var c = validCounts(); if (c) { saveOwn(c); queueSave(); } }, 'primary'));
      }
      root.appendChild(makeButton('Clear my contributions', function () { if (!confirm('Remove all of this device’s observations from this activity?')) return; saveOwn(a.outcomes.map(function () { return 0; })); updateOwnCounts(); queueSave(); }, 'text-link reset'));
    } else {
      var form = document.createElement('form'); form.className = 'data-form'; var label = document.createElement('label'); label.htmlFor = 'my-value'; label.textContent = 'Your value · ' + a.label;
      var input = document.createElement('input'); input.id = 'my-value'; input.type = 'number'; input.inputMode = 'numeric'; input.min = a.min; input.max = a.max; input.step = 1; input.required = true; if (own() !== undefined) input.value = own();
      var button = makeButton('Send my value ↗', null, 'primary'); button.type = 'submit'; form.append(label, input, button);
      form.onsubmit = function (e) { e.preventDefault(); var v = Number(input.value); if (!Number.isInteger(v) || v < a.min || v > a.max) { setSave('Enter a whole number from ' + a.min + ' to ' + a.max + '.', true); return; } saveOwn(v); queueSave(); }; root.appendChild(form);
      var note = document.createElement('p'); note.className = 'fine'; note.textContent = 'Whole numbers from ' + a.min + ' to ' + a.max + '. Prefer not to share? You can simply observe.'; root.appendChild(note);
    }
    if (own() !== undefined) setSave('Your previous contribution is saved on this device. You can update it.');
  }
  function bar(label, n, total) {
    var row = document.createElement('div'); row.className = 'bar-row'; var line = document.createElement('div'); line.className = 'bar-label'; var name = document.createElement('span'); name.textContent = label; var count = document.createElement('span'); count.textContent = n + (total ? ' · ' + (100 * n / total).toFixed(1) + '%' : ''); line.append(name, count);
    var track = document.createElement('div'); track.className = 'bar-track'; var fill = document.createElement('div'); fill.className = 'bar-fill'; fill.style.width = (total ? 100 * n / total : 0) + '%'; track.appendChild(fill); row.append(line, track); return row;
  }
  function drawSeries(root, f, values) {
    if (!values.length) { var empty = document.createElement('p'); empty.className = 'empty-chart'; empty.textContent = 'Waiting for the first answer.'; root.appendChild(empty); return; }
    if (f.kind === 'choice') f.options.forEach(function (label, i) { root.appendChild(bar(label, values.filter(function (v) { return v === i; }).length, values.length)); });
    else {
      var unique = Array.from(new Set(values)).sort(function (a, b) { return a - b; });
      if (unique.length <= 12) unique.forEach(function (v) { root.appendChild(bar(display(f, v), values.filter(function (x) { return x === v; }).length, values.length)); });
      else {
        var chunk = Math.ceil(unique.length / 6);
        for (var i = 0; i < unique.length; i += chunk) { var start = unique[i], end = unique[Math.min(i + chunk - 1, unique.length - 1)]; root.appendChild(bar(display(f, start) + '–' + display(f, end), values.filter(function (v) { return v >= start && v <= end; }).length, values.length)); }
      }
      if (f.kind !== 'clock') { var summary = document.createElement('p'); summary.className = 'fine'; summary.textContent = values.length + ' answers · mean ' + (values.reduce(function (x, y) { return x + y; }, 0) / values.length).toFixed(f.kind === 'decimal' ? f.places : 1) + (f.unit ? ' ' + f.unit : ''); root.appendChild(summary); }
    }
  }
  function draw() {
    var a = current, j = result, chart = $('chart'); chart.textContent = ''; $('mean-stat').hidden = a.kind !== 'value'; $('export').hidden = !!j.locked;
    if (j.locked) { $('total').textContent = '—'; $('participants').textContent = '—'; $('total-label').textContent = 'class answers'; $('result-note').textContent = 'Submit your own guess to see the class results. Read your assigned question first.'; return; }
    var n = a.kind === 'tally' ? j.total : j.series ? j.series.reduce(function (sum, s) { return sum + s.n; }, 0) : j.n;
    $('total').textContent = n; $('participants').textContent = j.series ? Math.max.apply(null, [0].concat(j.series.map(function (s) { return s.n; }))) : a.kind === 'tally' ? j.devices : j.n;
    $('participants-label').textContent = j.series ? 'largest answer sample' : 'devices contributing'; $('total-label').textContent = a.kind === 'tally' ? a.id === 'coin-sim' ? 'simulated tosses' : 'observations' : j.series ? 'shared answers' : 'shared values';
    if (a.kind === 'tally') a.outcomes.forEach(function (label, i) { chart.appendChild(bar(label, j.counts[i], n)); });
    else if (j.series) {
      j.series.forEach(function (s) { var section = document.createElement('section'); section.className = 'field-results'; var h = document.createElement('h3'); h.textContent = s.field.label; section.appendChild(h); drawSeries(section, s.field, s.values); chart.appendChild(section); });
      if (a.randomized || a.id === 'trip') {
        var grouped = document.createElement('section'); grouped.className = 'field-results'; var heading = document.createElement('h3'); heading.textContent = a.randomized ? 'Guesses by assigned group' : 'Trip time by way of getting to school'; grouped.appendChild(heading);
        var groupIndex = j.fields.indexOf(a.randomized ? 'group' : 'way'), valueIndex = j.fields.indexOf(a.randomized ? 'guess' : 'minutes'); var labels = a.randomized ? ['Group A', 'Group B'] : a.fields[0].options;
        labels.forEach(function (label, i) { var values = j.rows.filter(function (r) { return r[groupIndex] === i && r[valueIndex] !== null; }).map(function (r) { return r[valueIndex]; }); var p = document.createElement('p'); p.className = 'fine'; p.textContent = label + ': ' + values.length + ' answers' + (values.length ? ' · mean ' + (values.reduce(function (x, y) { return x + y; }, 0) / values.length).toFixed(1) + (a.randomized ? ' miles' : ' minutes') : ''); grouped.appendChild(p); }); chart.appendChild(grouped);
      }
    } else { $('mean').textContent = n ? (j.values.reduce(function (x, y) { return x + y; }, 0) / n).toFixed(1) : '—'; drawSeries(chart, { kind: 'int', unit: a.label }, j.values); }
    $('result-note').textContent = n ? a.source + ' · Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '. Each answer can be updated by its device.' : 'Waiting for the first contribution. Yours could be first.';
  }
  async function refresh() {
    try { result = await readResults(); draw(); $('room-connection').textContent = 'Room connected'; }
    catch (e) { $('room-connection').textContent = 'Reconnecting…'; $('result-note').textContent = 'Showing the last results. ' + e.message; }
  }
  function share() {
    var link = linkFor(code, current.id); $('share-link').value = link; $('share-code').textContent = code; $('share-prompt').textContent = current.prompt; $('copy-status').textContent = '';
    try { var g = qrcode(0, 'M'); g.addData(link); g.make(); $('qr').innerHTML = g.createSvgTag({ cellSize: 4, margin: 16, scalable: true }); }
    catch (_) { $('qr').textContent = 'QR unavailable. Share the student link below.'; } $('share-dialog').showModal();
  }
  function csvRows() {
    if (current.kind === 'tally') return [['outcome', 'count']].concat(current.outcomes.map(function (l, i) { return [l, result.counts[i]]; }));
    if (current.kind === 'record' && current.linked) return [result.fields.map(function (id) { return id === 'group' ? 'Assigned group' : current.fields.find(function (f) { return f.id === id; }).label; })].concat(result.rows.map(function (row) { return row.map(function (v, i) { return result.fields[i] === 'group' ? (v === null ? '' : ['A', 'B'][v]) : display(current.fields.find(function (f) { return f.id === result.fields[i]; }), v); }); }));
    if (result.series) return [['question', 'value']].concat(result.series.flatMap(function (s) { return s.values.map(function (v) { return [s.field.label, display(s.field, v)]; }); }));
    return [['value']].concat(result.values.map(function (v) { return [v]; }));
  }
  async function init() {
    catalog = await api('catalog'); var icons = ['◒', '◐', '⌁', '↥', '↗', '⚄', '◑'];
    catalog.forEach(function (a, i) {
      var card = makeButton('', function () { create(a.id); }, 'activity'); var icon = document.createElement('span'); icon.className = 'activity-icon'; icon.textContent = icons[i % icons.length]; icon.setAttribute('aria-hidden', 'true');
      var text = document.createElement('div'); var h = document.createElement('h3'); h.textContent = a.title; var desc = document.createElement('p'); desc.textContent = a.prompt; text.append(h, desc);
      var bottom = document.createElement('div'); bottom.className = 'activity-bottom'; var source = document.createElement('span'); source.textContent = a.source.toUpperCase(); var arrow = document.createElement('span'); arrow.textContent = 'START A ROOM ↗'; bottom.append(source, arrow); card.append(icon, text, bottom); $('activity-grid').appendChild(card);
      var option = document.createElement('option'); option.value = a.id; option.textContent = a.title; $('activity-select').appendChild(option);
    });
    $('start').onclick = function () { create(catalog[0].id); }; $('join-form').onsubmit = join;
    var q = new URLSearchParams(location.search); code = (q.get('code') || '').trim().toUpperCase(); if (!code) return;
    if (!/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) throw new Error('That class code is not valid. Check the link or enter your teacher’s code.');
    current = catalog.find(function (a) { return a.id === q.get('activity'); }) || catalog[0];
    if (locked()) await api(endpoint(code, { id: 'pulse' }));
    result = await readResults(); $('home').hidden = true; $('room').hidden = false;
    $('room-code').textContent = code; $('room-title').textContent = current.title; $('room-prompt').textContent = current.prompt; $('room-source').textContent = current.source.toUpperCase() + ' / ' + current.label.toUpperCase();
    $('teacher-note').hidden = !store.keys[code]; $('activity-select').value = current.id;
    $('activity-select').onchange = function () { if (sending || dirty || !$('retry').hidden) { error('Send your pending contribution before switching activities.'); $('activity-select').value = current.id; return; } location.href = linkFor(code, this.value); };
    entry(current); draw(); $('room-connection').textContent = 'Room connected'; $('retry').onclick = function () { dirty = true; send(); };
    $('share').onclick = share; $('close-share').onclick = function () { $('share-dialog').close(); };
    $('copy-link').onclick = async function () { try { await navigator.clipboard.writeText($('share-link').value); $('copy-status').textContent = 'Student link copied.'; } catch (_) { $('share-link').focus(); $('share-link').select(); $('copy-status').textContent = 'Select and copy the student link above.'; } };
    $('export').onclick = function () {
      if (locked()) return;
      var rows = csvRows(); var csv = rows.map(function (row) { return row.map(function (v) { var text = String(v); return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text; }).join(','); }).join('\n') + '\n';
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' }); var u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = 'opSHion-' + code + '-' + current.id + '.csv'; a.click(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    };
    setInterval(function () { if (!document.hidden) refresh(); }, 5000); document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('beforeunload', function (e) { if (sending || dirty) { e.preventDefault(); e.returnValue = ''; } });
    if (store.keys[code] && !sessionStorage.getItem('opshion.shared.' + code)) { sessionStorage.setItem('opshion.shared.' + code, '1'); share(); }
  }
  init().catch(function (e) { error(e.message || 'Could not connect. Please reload to try again.'); });
})();
