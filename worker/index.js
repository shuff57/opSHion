import { handle } from '../functions/api/classdata/[[path]].js';
import html from '../web/index.html';
import app from '../web/app.js';
import style from '../web/style.css';
import qr from '../web/qrcode.js';
import { TOPICS, TALLY_TOPICS } from '../functions/_lib/classdata_topics.js';

const CATALOG = [
  { id: 'coin-sim', kind: 'tally', title: 'Coin toss lab', label: 'Simulated tosses', prompt: 'Toss a fair virtual coin. How close does the class get to half heads?', source: 'Simulated', outcomes: ['Heads', 'Tails'] },
  { id: 'coin-real', kind: 'tally', title: 'Real coin tally', label: 'Real tosses', prompt: 'Toss a real coin. Record each result below, or enter your batch totals.', source: 'Real observations', outcomes: ['Heads', 'Tails'] },
  { id: 'pulse', kind: 'value', title: 'Resting pulse', label: 'beats / minute', prompt: 'Count your pulse for one minute. What is your resting heart rate?', source: 'Class data' },
  { id: 'height', kind: 'value', title: 'How tall are we?', label: 'centimeters', prompt: 'Enter your height in whole centimeters.', source: 'Class data' },
  { id: 'commute', kind: 'value', title: 'The trip to school', label: 'minutes', prompt: 'How many minutes does it take you to get to school, one way?', source: 'Class data' },
  { id: 's31-die', kind: 'tally', title: 'Roll a real die', label: 'Real rolls', prompt: 'Roll a six-sided die. Add your observed counts for each face.', source: 'Real observations', outcomes: ['1', '2', '3', '4', '5', '6'] },
  { id: 's32-toss2', kind: 'tally', title: 'Two real coins', label: 'Real pairs', prompt: 'Toss two coins in order. Record HH, HT, TH or TT for each pair.', source: 'Real observations', outcomes: ['HH', 'HT', 'TH', 'TT'] },
].map(a => ({ ...a, ...(a.kind === 'value' ? { min: TOPICS[a.id].min, max: TOPICS[a.id].max } : { maxTotal: TALLY_TOPICS[a.id].maxTotal }) }));

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    const headers = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" };
    try {
      let response;
      if (u.pathname === '/api/catalog') response = Response.json(CATALOG);
      else if (u.pathname.startsWith('/api/classdata/')) response = await handle(request, env);
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
