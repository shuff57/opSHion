# opSHion

A public classroom lab for shared polls, chance simulations, and real data.

**Student app:** https://opshion.lefthanddev.com

Start a room, project its QR code, and let students contribute from their phones. No accounts or names are required. Every room has a six-character code; a QR link includes both the code and the activity. Anyone can start a room and try it.

## Activities

- **Coin toss lab:** fair virtual coin tosses, individually or in batches of 10 or 100.
- **Real coin tally:** enter observed heads and tails, or tap each result.
- **Real dice and two-coin experiments:** share outcome counts.
- **Class data:** enter resting pulse, height in centimeters, or commute time in minutes.

Real observations and simulated tosses use separate pools. Each device contributes its own tally or one numeric value per activity; resubmitting replaces that contribution. Results refresh every five seconds, and can be downloaded as CSV. No contribution is sent until a student acts. Failed writes remain on the device with a retry action.

## Run and test

Node 22.13 or newer:

```sh
npm ci
npm run build
npm test
```

The API tests use Node's built-in SQLite and exercise actual SQL, including validation, class creation, aggregation, rate limits, teacher keys and origin restrictions.

For the complete two-student browser check:

```sh
python -m pip install playwright opencv-python-headless
python -m playwright install chromium
npm run test:browser
```

The browser suite starts an ephemeral local test server with in-memory SQLite. It checks QR decoding, joining on fresh devices, multiple contributors, reloads without duplicates, numeric updates, CSV downloads, invalid codes and phone layout. This test harness is never deployed.

## Deploy

The production app is a Cloudflare Worker with a D1 database. `npm run build` bundles the frontend and API into `dist/server/index.js`. `.openai/hosting.json` identifies the Sites project and its `DB` binding. The Sites workflow packages that output and applies the schema in `drizzle/` before deploying.

`drizzle/0000_class_data.sql` is the initial production migration. Append future migrations rather than modifying applied SQL. `migrations/` retains the individual API migrations used by the inherited regression suite.

Public GitHub pushes do **not** publish the app automatically. Deploy a tested source commit through Sites, then verify the public endpoint. The custom domain must point to the DNS target returned by Sites.

## Embed in a textbook or another app

Link directly to an activity:

```
https://opshion.lefthanddev.com/?code=ABC234&activity=coin-sim
https://opshion.lefthanddev.com/?code=ABC234&activity=coin-real
https://opshion.lefthanddev.com/?code=ABC234&activity=pulse
```

Create a room in opSHion first; `ABC234` is an example. Room codes belong to this app's database. Existing bookSHelf codes are not automatically migrated.

The public catalog is at `/api/catalog`. The `/api/classdata/` routes retain the bookSHelf contract for numeric values, outcome tallies and structured records. The deployed book at `https://oerbookshelf.app` is allowed to create rooms and read or submit class data through a restricted CORS policy. Other browser origins remain blocked. Student QR links open this app directly. The book’s 5.1 pulse histogram reads the same pool as the opSHion pulse entry page.

## Data and limits

The service stores numbers and outcome counts, not student names or email addresses. A browser keeps a random device ID; the server stores its hash scoped to the room. Clearing browser storage creates a new device, so this is a classroom exploration tool, not authenticated assessment. Room codes permit anyone who knows the code to contribute and see the shared results.

Teacher keys stay on the creating device and are never included in QR links. The service applies per-network and per-class write limits. Class data expires after 400 days and is cleaned up when new rooms are created. Numeric results are anonymous but visible to room participants; avoid entering identifying data. This initial frontend does not expose teacher moderation or custom question authoring.

## Source

The class-data API and regression tests were extracted from the author's bookSHelf project. The bundled QR encoder retains its upstream license in `web/qrcode.LICENSE.txt`. No textbook chapters, media, production database identifiers, credentials, or student data are included.
