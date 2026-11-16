import { handle } from '../functions/api/classdata/[[path]].js';
import html from '../web/index.html';
import app from '../web/app.js';
import style from '../web/style.css';
import qr from '../web/qrcode.js';
import { TOPICS, TALLY_TOPICS, RECORD_TOPICS } from '../functions/_lib/classdata_topics.js';

// IDs match the book's API registry. Only labels and classroom instructions live here.
const VALUE_TITLES = {
  pulse: 'Resting pulse', height: 'How tall are we?', commute: 'The trip to school',
  's61-rent5': 'Five rent cards', 's62-song': 'One song', 's62-run4': 'Four-song playlist',
};
const TALLY_DETAILS = {
  'coin-sim': ['Coin toss lab', 'Toss a fair virtual coin. How close does the class get to half heads?'],
  'coin-real': ['Real coin tally', 'Toss a real coin. Record each result below, or enter your batch totals.'],
  's31-die': ['Roll a real die', 'Roll a six-sided die. Record the face shown on each roll.'],
  's32-toss2': ['Two real coins', 'Toss a nickel, then a dime. Record the two results in that order.'],
  's32-spin8': ['Eight-slice spinner', 'Spin an eight-slice spinner labeled 1 to 8. Record each landing.'],
  's32-bag-back': ['Tiles with replacement', 'Use a bag with two blue and two orange tiles. Draw a tile, put it back, then draw again. Record both colors in order: B for blue, O for orange.'],
  's32-bag-keep': ['Tiles without replacement', 'Use a bag with two blue and two orange tiles. Draw two tiles without putting the first back. Record colors in order. Return both tiles before the next trial.'],
  's33-toss2': ['Two-coin experiment', 'Toss a nickel, then a dime. Record the results in order for each pair.'],
  's33-bag-keep': ['Three-tile bag', 'Use a bag with two blue tiles and one orange tile. Draw two without replacement and record colors in order. Return both before the next trial.'],
  's34-survey': ['Lunch-place survey', 'Survey students about their lunch place and grade. Add one count to the matching place and grade for each student.'],
  's35-cups': ['Two cups, two colors', 'Follow the activity’s cup setup. A coin selects Cup 1 or Cup 2; draw one tile from that cup and record the cup and color. Replace the tile before the next play.'],
  's41-dice2': ['Sum of two dice', 'Roll a red die and a blue die. Add their faces and record the sum for each roll.'],
  's42-ring': ['Ring-toss winnings', 'Play the activity’s real ring-toss game. Record the dollar value of the spike where each ring lands.'],
  's42-die': ['Die points game', 'Roll one six-sided die for the activity’s points game. Record the face shown on each roll.'],
  's43-sixes3': ['Sixes in three rolls', 'Roll one die three times per round. Record how many of the three rolls were sixes.'],
  's45-clock': ['Second-hand readings', 'Observe a real clock’s second hand at the times chosen in the activity. Record which five-second interval contains each reading.'],
  's63-spin8': ['Spinner sample', 'Spin the activity’s eight-slice spinner, labeled 1 to 8. Record the slice for every spin.'],
};
const RECORD_TITLES = { alphabet: 'Alphabet stopwatch', sleep: 'School-day sleep', anchor: 'A guess after a number', planes: 'Paper-plane distances', trip: 'Getting to school' };
const scalar = t => ({ ...t, kind: 'value', title: VALUE_TITLES[t.id], label: t.unit, prompt: t.question, source: 'Class data' });
const CATALOG = [
  ...Object.values(TALLY_TOPICS).slice(0, 2).map(t => ({ ...t, kind: 'tally', title: TALLY_DETAILS[t.id][0], label: t.noun, prompt: TALLY_DETAILS[t.id][1], source: t.id === 'coin-sim' ? 'Simulated' : 'Real observations' })),
  ...Object.values(TOPICS).map(scalar),
  ...Object.values(RECORD_TOPICS).map(({ randomize, ...t }) => ({ ...t, kind: 'record', title: RECORD_TITLES[t.id], label: t.noun, prompt: t.question, source: 'Class data', randomized: !!randomize })),
  ...Object.values(TALLY_TOPICS).slice(2).map(t => ({ ...t, kind: 'tally', title: TALLY_DETAILS[t.id][0], label: t.noun, prompt: TALLY_DETAILS[t.id][1], source: 'Real observations' })),
  ...[
    { id: 'pulse-commute', title: 'Pulse and the trip to school', prompt: 'Share your resting pulse and your one-way trip time for the class activity.', topics: ['pulse', 'commute'] },
    { id: 'height-pulse', title: 'Height and pulse', prompt: 'Share your height and resting pulse for the class activity.', topics: ['height', 'pulse'] },
    { id: 'playlist', title: 'One song and a playlist', prompt: 'Draw from the eight song cards (2, 3, 3, 3, 4, 4, 4, 9 minutes), replacing each card. Record one song, then the total for a separate run of four songs.', topics: ['s62-song', 's62-run4'] },
  ].map(({ topics, ...a }) => ({ ...a, kind: 'bundle', label: 'two measurements', source: 'Class data', fields: topics.map(id => ({ ...scalar(TOPICS[id]), kind: 'int', label: VALUE_TITLES[id] })) })),
];

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    // The book can create/read the same rooms; all other browser origins stay isolated.
    const bookOrigins = ['https://oerbookshelf.app'];
    const origin = request.headers.get('Origin');
    const isApi = u.pathname.startsWith('/api/classdata/');
    const allowedBook = isApi && bookOrigins.includes(origin);
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" };
    if (allowedBook) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Teacher-Key';
      headers['Vary'] = 'Origin';
    }
    if (request.method === 'OPTIONS' && isApi) return new Response(null, { status: allowedBook ? 204 : 403, headers });
    try {
      let response;
      if (u.pathname === '/api/catalog') response = Response.json(CATALOG);
      else if (u.pathname.startsWith('/api/classdata/')) {
        const assignmentRequest = u.pathname === '/api/classdata/assign' ? request.clone() : null;
        response = await handle(request, { ...env, CLASSDATA_ALLOWED_ORIGINS: bookOrigins });
        // Reveal only this device's assigned prompt. The public catalog never contains either prompt.
        if (u.pathname === '/api/classdata/assign' && response.ok) {
          const assigned = await response.json();
          const body = await assignmentRequest.json();
          const group = RECORD_TOPICS[body.topic]?.randomize?.groups[assigned.group];
          response = Response.json({ ...assigned, ...(group ? { prompt: group.prompt } : {}) });
        }
      }
      else {
        const assets = { '/': [html, 'text/html'], '/app.js': [app, 'text/javascript'], '/style.css': [style, 'text/css'], '/qrcode.js': [qr, 'text/javascript'] };
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers });
        const asset = assets[u.pathname];
        response = asset ? new Response(request.method === 'HEAD' ? null : asset[0], { headers: { 'Content-Type': asset[1] + '; charset=utf-8' } }) : new Response('Not found', { status: 404 });
      }
      const out = new Response(response.body, response);
      for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
      return out;
    } catch {
      return Response.json({ error: 'The room is unavailable right now. Please try again.' }, { status: 503, headers });
    }
  },
};
