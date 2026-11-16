// Topic registry for the class data API (functions/api/classdata/[[path]].js).
// One list shared by the API, a test, and (copied by the front end's classdata.js) the sims. Values are whole numbers in [min, max].
// Plan: projects/Introduction to Stats/factory/plans/classdata-ch5.md
export const TOPICS = Object.freeze({
  pulse: Object.freeze({
    id: 'pulse', min: 40, max: 140, unit: 'beats per minute',
    question: 'Your resting pulse: count the beats for 30 seconds and double it',
  }),
  height: Object.freeze({
    id: 'height', min: 120, max: 220, unit: 'cm',
    question: 'Your height',
  }),
  commute: Object.freeze({
    id: 'commute', min: 0, max: 180, unit: 'minutes',
    question: 'Minutes it takes you to get to school (one way)',
  }),
  // Chapter 6 data-set Investigates (Real/Sim redo 2026-11-13): one value per device is the student's OWN result of one round.
  // 6.1: the average of five rent cards (each put back) from the thirty cards of the Investigate (650 to 3,200 dollars).
  's61-rent5': Object.freeze({
    id: 's61-rent5', min: 650, max: 3200, unit: 'dollars',
    question: 'Draw five rent cards, putting each card back. Add the five rents and divide by 5',
  }),
  // 6.2: the eight song cards (2, 3, 3, 3, 4, 4, 4 and 9 minutes), played with repeats: one song, and the total of a run of four songs.
  's62-song': Object.freeze({
    id: 's62-song', min: 2, max: 9, unit: 'minutes',
    question: 'Play one song: draw one song card and read its length',
  }),
  's62-run4': Object.freeze({
    id: 's62-run4', min: 8, max: 36, unit: 'minutes',
    question: 'Play a run of four songs, putting each card back. Add the four lengths',
  }),
});

// Tally topics (2026-11-13): a chance-process Investigate pools REAL trials. A student makes many trials, so one device sends a TALLY:
// a count for each outcome, in the order of `outcomes`. One tally per device per topic per class (re-sending replaces it).
// The id names the section and the chance-sim frame (tools/chance-sim, link flag class=1), so two sections never pool into one list:
// 3.2's bag has four tiles and 3.3's has three, so their draws are different experiments even with the same outcome labels.
// `noun` is one trial (for messages). `maxTotal` bounds one device's trials. A new frame adds its topic here (additive only).
const tally = (id, noun, outcomes, maxTotal = 10000) => Object.freeze({ id, noun, outcomes: Object.freeze(outcomes.slice()), maxTotal });
const SURVEY_CELLS = ['Outside', 'Cafeteria', 'Library'].flatMap(p => ['Ninth', 'Tenth', 'Eleventh'].map(g => `${p}, ${g}`));
export const TALLY_TOPICS = Object.freeze({
  'coin-sim': tally('coin-sim', 'simulated toss', ['Heads', 'Tails']),
  'coin-real': tally('coin-real', 'real toss', ['Heads', 'Tails']),
  's32-toss2': tally('s32-toss2', 'toss', ['HH', 'HT', 'TH', 'TT']),                          // nickel then dime
  's32-spin8': tally('s32-spin8', 'spin', ['1', '2', '3', '4', '5', '6', '7', '8']),
  's32-bag-back': tally('s32-bag-back', 'draw', ['BB', 'BO', 'OB', 'OO']),                     // four tiles, first one put back
  's32-bag-keep': tally('s32-bag-keep', 'draw', ['BB', 'BO', 'OB', 'OO']),                     // four tiles, first one kept out
  's33-toss2': tally('s33-toss2', 'toss', ['HH', 'HT', 'TH', 'TT']),
  's33-bag-keep': tally('s33-bag-keep', 'draw', ['BB', 'BO', 'OB', 'OO']),                     // three tiles, first one kept out
  's34-survey': tally('s34-survey', 'student', SURVEY_CELLS),                                  // lunch place, grade
  's41-dice2': tally('s41-dice2', 'roll', ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']),   // sum of a red and a blue die
  's42-ring': tally('s42-ring', 'toss', ['$0', '$1', '$5']),                                     // the spike the ring lands on
  's42-die': tally('s42-die', 'roll', ['1', '2', '3', '4', '5', '6']),                           // 4.2 points game: the face of one die (Real/Sim redo 2026-11-13)
  's45-clock': tally('s45-clock', 'reading', ['0 to 5', '5 to 10', '10 to 15', '15 to 20', '20 to 25', '25 to 30', '30 to 35', '35 to 40', '40 to 45', '45 to 50', '50 to 55', '55 to 60']),   // 4.5: the 5-second stretch of the dial a second-hand reading falls in
  's31-die': tally('s31-die', 'roll', ['1', '2', '3', '4', '5', '6']),                            // the face of one die (3.1, Real/Sim redo 2026-11-13)
  's63-spin8': tally('s63-spin8', 'spin', ['1', '2', '3', '4', '5', '6', '7', '8']),              // 6.3: the slice of the eight-slice spinner (Real/Sim redo 2026-11-13)
  's43-sixes3': tally('s43-sixes3', 'round', ['0', '1', '2', '3']),
  's35-cups': tally('s35-cups', 'play', ['Cup 1, red', 'Cup 1, green', 'Cup 2, red', 'Cup 2, green']),   // 3.5 (2026-11-14): a coin picks the cup, then one tile                              // 4.3 (2026-11-14): sixes in one round of three rolls of one die
});

// Record topics (chapters 1 and 2, 2026-11-14; migration 0018; plan: projects/Introduction to Stats/factory/plans/classdata-ch12.md,
// API notes: classdata-ch12-api.md). One topic per ACTIVITY, so a class pool carries into the later section ("Reuse the pool").
// A student gives one RECORD per topic per class: several fields kept together. Every field is a number, stored as an INTEGER:
//   int      whole number in [min, max] (optional step)
//   decimal  a number with at most `places` decimal places in [min, max] (optional step); stored as value * 10^places
//   clock    minutes after midnight, a whole number in [min, max] that is a multiple of `step` (5-minute steps)
//   choice   the index of one of `options` (0, 1, ...); `ordered` says whether the options have an order (ordinal) or not
// No free text anywhere. The API speaks DISPLAY units (5.83 seconds, 4.3 m, 405 minutes after midnight, option index); storage is integer.
// `key` is where a field is stored: `<topic>.<field>` unless given. trip.minutes is stored under `commute`, so the chapter 5 commute
// pool and the 2.4/2.5 minutes are ONE list (a 5.2 value shows in 2.5 and the other way round).
// `linked` topics may be read as whole records by students (GET /records); the rest are read one field at a time (GET /values), so a
// small class's answers cannot be matched up into one student's. `randomize`: the server puts each new record in group A or B, in blocks
// of two arrivals per class code (POST /assign); fields with `afterAssign` are accepted only once the record has its group.
// A field's `question` heads the entry when a page asks for that field alone (2.5 asks only for the minutes).
// `sections` lists the sections that read the topic, in order: a later section shows "your class's data from Section X".
const field = f => Object.freeze({ ...f, ...(f.options ? { options: Object.freeze(f.options.slice()) } : {}) });
const recordTopic = t => Object.freeze({
  ...t,
  sections: Object.freeze(t.sections.slice()),
  fields: Object.freeze(t.fields.map(field)),
  ...(t.randomize ? { randomize: Object.freeze({ groups: Object.freeze(t.randomize.groups.map(g => Object.freeze({ ...g }))) }) } : {}),
});
export const RECORD_TOPICS = Object.freeze({
  alphabet: recordTopic({
    id: 'alphabet', sections: ['1.2', '2.2'], noun: 'alphabet run',
    question: 'Say the alphabet: one partner says A to Z as fast as they can while the other times it',
    fields: [
      { id: 'how', kind: 'choice', label: 'How you did it', options: ['spoke it', 'sang it'], ordered: false },
      { id: 'tries', kind: 'int', label: 'Tries until a run with no slip (stop at 5)', unit: 'tries', min: 1, max: 5 },
      { id: 'seconds', kind: 'decimal', places: 2, label: 'Seconds for the clean run, as the stopwatch shows them', unit: 'seconds', min: 1, max: 60 },
    ],
  }),
  sleep: recordTopic({
    id: 'sleep', sections: ['1.3', '2.6'], noun: 'school-day sleep',
    question: 'Your school-day sleep',
    fields: [
      { id: 'wakes', kind: 'choice', label: 'What wakes you on a school day', options: ['phone alarm', 'other alarm', 'a person', 'on my own'], ordered: false },
      { id: 'sleepy', kind: 'choice', label: 'How often you are very sleepy on a school day', options: ['never', 'rarely', 'sometimes', 'often', 'almost always'], ordered: true },
      { id: 'wake', kind: 'clock', label: 'Wake time on a school day', unit: 'time', min: 0, max: 1435, step: 5 },
      { id: 'hours', kind: 'decimal', places: 1, step: 0.5, label: 'Hours of sleep on a school night, to the nearest half hour', unit: 'hours', min: 0, max: 16 },
      { id: 'weekend', kind: 'clock', label: 'Wake time on a weekend day', unit: 'time', min: 0, max: 1435, step: 5 },
    ],
  }),
  anchor: recordTopic({
    id: 'anchor', sections: ['1.4'], noun: 'guess', linked: true,
    question: 'A guess after a number',
    randomize: { groups: [
      { id: 'A', prompt: 'Is San Francisco to New York City more or less than 1,500 miles?' },
      { id: 'B', prompt: 'Is San Francisco to New York City more or less than 6,000 miles?' },
    ] },
    fields: [
      { id: 'trip', kind: 'choice', label: 'Have you traveled between the East and West Coasts?', options: ['no', 'yes'], ordered: false },
      { id: 'guess', kind: 'int', label: 'Your guess: how many miles is it from San Francisco to New York City?', unit: 'miles', min: 0, max: 20000, afterAssign: true },
    ],
  }),
  planes: recordTopic({
    id: 'planes', sections: ['2.1', '2.3'], noun: 'plane throw',
    question: 'One paper plane each: how far it flew from the line, to the nearest 0.1 m',
    fields: [
      { id: 'metres', kind: 'decimal', places: 1, label: 'How far your plane flew', unit: 'm', min: 0, max: 60 },
    ],
  }),
  trip: recordTopic({
    id: 'trip', sections: ['2.4', '2.5'], noun: 'trip to school', linked: true,
    question: 'How you got to school today and how long it took',
    fields: [
      { id: 'way', kind: 'choice', label: 'How you got to school today', options: ['car', 'bus or train', 'walk or bike', 'other'], ordered: false },
      { id: 'minutes', kind: 'int', label: 'Minutes it took (one way)', unit: 'minutes', min: 0, max: 180, key: 'commute',
        question: 'Your trip to school today: how many minutes it took, one way' },
    ],
  }),
});

// 31 characters, no I, L or O (they read as 1 and 0).
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export function getTopic(id) {
  return typeof id === 'string' && Object.hasOwn(TOPICS, id) ? TOPICS[id] : null;
}
export function getTallyTopic(id) {
  return typeof id === 'string' && Object.hasOwn(TALLY_TOPICS, id) ? TALLY_TOPICS[id] : null;
}
export function getRecordTopic(id) {
  return typeof id === 'string' && Object.hasOwn(RECORD_TOPICS, id) ? RECORD_TOPICS[id] : null;
}
export function getField(topic, id) {
  return (topic && topic.fields && typeof id === 'string' && topic.fields.find(f => f.id === id)) || null;
}
// Where a field's values live in class_values.topic.
export const storageKey = (topic, f) => f.key || `${topic.id}.${f.id}`;

const pow = f => (f.kind === 'decimal' ? 10 ** f.places : 1);
// Display value -> stored integer, or { error }. Every rule a field has is checked here, so the API and the tests share one definition.
export function toStored(f, v) {
  const unit = f.unit ? ` (${f.unit})` : '';
  if (f.kind === 'choice') {
    if (Number.isInteger(v) && v >= 0 && v < f.options.length) return { value: v };
    return { error: `${f.id} must be the number of one choice, 0 to ${f.options.length - 1} (${f.options.join(', ')}).` };
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${f.id} must be a number.` };
  const p = pow(f), s = v * p, r = Math.round(s);
  const lo = Math.round(f.min * p), hi = Math.round(f.max * p), step = Math.round((f.step || (f.kind === 'clock' ? 5 : 1 / p)) * p);
  const onGrid = Math.abs(s - r) < 1e-6 && (r - lo) % step === 0;
  if (!onGrid || r < lo || r > hi) {
    if (f.kind === 'int') return { error: `${f.id} must be a whole number from ${f.min} to ${f.max}${unit}.` };
    if (f.kind === 'clock') return { error: `${f.id} must be minutes after midnight, ${f.min} to ${f.max}, in steps of ${f.step || 5} minutes.` };
    return { error: `${f.id} must be a number from ${f.min} to ${f.max} in steps of ${f.step || 1 / p}${unit}.` };
  }
  return { value: r };
}
// Stored integer -> display value.
export function fromStored(f, n) {
  return f.kind === 'decimal' ? Number((n / pow(f)).toFixed(f.places)) : n;
}
