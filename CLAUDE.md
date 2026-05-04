# PointsYeah CLI — Agent Context

> This file is the entry point for any AI agent (Claude Code, GitHub Copilot, etc.) working on this repo. Read it cold; you'll have full context after.

## What this is

A personal-use Node 22 + TypeScript CLI that wraps **pointsyeah.com**'s award-flight search API and places **Google Flights cash prices** side-by-side. The user uses it to decide whether to spend points or pay cash for a given flight.

The CLI is the iteration platform; the user wants this as a **Next.js frontend** (Vercel + Railway) eventually. Don't lose sight of that.

PointsYeah's API is reverse-engineered from their site's JS bundle (it has no public API). PointsYeah charges for **price-drop alerts**, not search itself, so search-side automation for personal use is fine. **Don't redistribute or productize this.**

## Quick start

```bash
# One-time per ~quarter (when Google session expires):
npm run auth-setup           # Headed Chromium, sign in via Google once

# Every search after:
npm run search -- JFK LAX 6/9/2026                            # one day
npm run search -- JFK LAX 6/9/2026 --flex 7 --cabin economy   # 8-day window
npm run search -- JFK NRT 6/15/2026 --cabin business --sort cpp  # CPP-sorted
```

The CLI auto-refreshes its Cognito idToken via headless Playwright when the cached one's `exp` is <5 min out.

## Stack & dependencies

| Component | What | Why |
|--|--|--|
| Node 22, ESM, top-level await | Runtime | User's stack rule (CLAUDE.md global). `tsx` for `.ts` execution. |
| TypeScript strict | Source | Existing code is strict. Don't add @types/node — keep it lean; tsx handles types. |
| `playwright` + `playwright-extra` + `puppeteer-extra-plugin-stealth` | Browser auth | Google blocks vanilla Playwright Chromium with "Couldn't sign you in"; stealth plugin patches `navigator.webdriver` and friends. |
| `uv` (Homebrew) → managed Python 3.12 | Python runtime for fast-flights | macOS Homebrew Python 3.12 has a broken libexpat; uv fetches its own. |
| `fast-flights==3.0rc1` | Google Flights scraper | Cloned at `flights/` (gitignored), installed in editable mode into `.venv`. |

## Repo layout

```
.
├── CLAUDE.md                   ← you are here
├── package.json                npm scripts: search, auth-setup, auth-refresh
├── tsconfig.json
├── .gitignore                  excludes node_modules, .venv, .auth-state, .cache, *.har, .env*, flights/
├── .env                        (gitignored) optional manual POINTSYEAH_ID_TOKEN — auth cache supersedes
├── .venv/                      (gitignored) uv-managed Python 3.12 + fast-flights
├── .auth-state/                (gitignored) Playwright persistent profile after auth-setup
├── flights/                    (gitignored) third-party clone of AWeirdDev/flights
├── src/
│   ├── pointsyeah.ts           PointsYeah API client: encryption, createTask, fetchResultOnce, search() with merge
│   ├── auth.ts                 ensureFreshIdToken() — cache lookup + on-demand Playwright refresh
│   └── test-search.ts          The actual CLI: arg parsing, filters, render, cash matching
├── scripts/
│   ├── auth-setup.ts           One-time headed sign-in (Playwright + stealth)
│   ├── auth-refresh.ts         Headless token refresh, exports refreshIdToken()
│   ├── cash_quote.py           Google Flights wrapper: --batch mode reads JSON from stdin, writes to PY_OUT
│   ├── test-flex.ts            One-shot probe to verify multi-day API support
│   └── dump-response.ts        Debug helper: dump raw fetch_result snapshots
└── ~/.cache/pointsyeah/        (outside repo) idToken + cash-{from}-{to}-{date}-{cabin}-{airline}.json
```

## Data flow (end-to-end)

```
┌────────────────┐   1. Read cached idToken or refresh via Playwright headless
│  test-search   │
│   (Node CLI)   │   2. Encrypted POST create_task → task_id
│                │
│                │   3. Poll fetch_result every 50ms (server long-polls ~3s when empty)
│                │      → merged ProgramResult[] (server fans out 16 sub-tasks per date)
│                │
│                │   4. As points results land, derive (date, cabin, airline) tuples
│                │      from rows that pass user filters
│                │
│                │   5. Debounce 300ms → batched Python subprocess (cash_quote.py --batch)
│                │      writes to PY_OUT temp file → Node reads
│                │
│                │   6. Match each row's first segment to airline's same-day trips
│                │      → exact (±15 min) or airline-cheapest fallback
│                │
│                │   7. Render: TTY uses ANSI clear+redraw, non-TTY does single batch print
└────────────────┘
```

## PointsYeah API (reverse-engineered)

### Endpoints

| Endpoint | Purpose |
|--|--|
| `POST https://api2.pointsyeah.com/flight/search/create_task` | Submit a search; returns `task_id` |
| `POST https://api2.pointsyeah.com/flight/search/fetch_result` | Poll for results (long-polling: holds ~3s when no new data) |

### Auth

- `Authorization: <raw idToken>` — **NO `Bearer ` prefix.** Their API Gateway uses Cognito User Pool authorizer which expects raw JWTs.
- No cookies, no other custom headers needed.
- CORS pinned to `https://www.pointsyeah.com` — irrelevant for a Node client (CORS is browser-only).

### Encryption envelope

The `create_task` request body looks like:
```json
{ "data": "<base64>", "encrypted": "<base64>" }
```

Both fields are AES-256-CBC ciphertexts of the **same plaintext** (the search query JSON). The trick:
- **`data`**: encrypted with a key derived from the **default key section** `"hJuaknzb"`.
- **`encrypted`**: encrypted with a key derived from `idToken.payload.jti.slice(0, 8)` (proof-of-auth: server can verify the user is logged in by matching against their JWT).

Key derivation:
```ts
const key = Buffer.from("LefjQ2pEXmiy/nNZvhJ43i8" + section + "YHYbn1hOuAgA=", "base64");  // 32 bytes
const iv  = Buffer.from("1020304050607080", "utf8");  // 16 bytes, hardcoded
```

Mode: `AES-256-CBC` with PKCS#7 padding. Implemented in `src/pointsyeah.ts` as `encryptPayload()`.

**Critical**: when not authenticated, both fields encrypt with the same default key, server detects this and returns **synthetic teaser data** (fake AR/AY flight numbers operating JFK-LAX domestic, `seats: 9999`, unrealistic prices). This isn't an error response — the structure is identical, only the content is fake. Always verify with `seats` field; real data has small numbers (0-9), teasers use 9999.

### create_task plaintext (decrypted)

```json
{
  "search_type": "one_way",
  "cabins": ["Economy", "Premium Economy", "Business", "First"],
  "segments": [
    {
      "departure": "JFK",
      "arrival": "LAX",
      "departure_date": { "from": "2026-06-09", "to": "2026-06-09" }
    }
  ],
  "passengers_v2": { "adults": 1, "children": 0 },
  "source": "mobile"
}
```

- **`departure_date.{from, to}`** supports multi-day ranges (the `--flex` feature). API has no documented cap; tested up to 30 days. The website's "8-day flex search" being a paid feature is **purely client-side** (`isFreePlan: true` in localStorage); the API doesn't enforce it.
- `search_type` also supports `"round_trip"` — **not yet wired in our code**. This is one of the planned next features.

### fetch_result plaintext request

`{"task_id": "<id>"}`. No encryption needed.

### Response shape (the real, useful stuff)

```ts
type FetchResultResponse = {
  code: number,
  success: boolean,
  data: {
    status: "processing" | "done" | "completed",
    result: ProgramResult[],
  }
};

type ProgramResult = {
  program: string,         // "United MileagePlus", full name
  code: string,            // "UA", IATA-style
  date: string,            // "2026-06-09"
  departure: string,       // "JFK"
  arrival: string,         // "LAX"
  routes: Route[],
};

type Route = {
  payment: {
    miles: number,         // award cost
    tax: number,           // USD
    cabin: string,         // "Economy" | "Premium Economy" | "Business" | "First"
    seats: number,         // availability
  },
  segments: Segment[],
  duration: number,        // total minutes
  cross_days: number,
  url: string,             // direct booking URL on airline site
  transfer: TransferPartner[],  // banks whose points convert to this loyalty currency
};

type Segment = {
  flight_number: string,   // "UA1643" — IATA prefix gives operating airline
  aircraft: string,
  dt: string,              // "2026-06-09T00:15:00" — local time, no TZ
  da: string,              // departure airport
  at: string,              // arrival datetime
  aa: string,              // arrival airport
  layover: number,         // minutes
  cabin: string,
  duration: number,        // minutes
};

type TransferPartner = {
  bank: string,            // "Chase Ultimate Rewards", full name
  code: string,            // "Chase", "Bilt", "Amex", "Citi", "Capital One"
  points: number,          // post-bonus
  actual_points: number,   // pre-bonus
  bonus_percentage: number,
  url: string,
};
```

### Polling cadence

Server long-polls (~3s server-side wait when no new data). Set `pollIntervalMs: 50` — back-to-back polling lets the server's pacing be the rate-limiter. Don't add longer sleeps.

`status` flips from `"processing"` to `"done"`. Treat both `"done"` and `"completed"` as terminal (server uses `"done"`; we kept `"completed"` as belt-and-suspenders).

## Auth subsystem

### The problem

Cognito idTokens are **1-hour TTL**. Amplify v6 keeps fresh tokens in memory only — `localStorage` keeps a stale copy from when the user first signed in months ago. The user's account is **federated via Google**, so Cognito refresh tokens get bypassed in favor of silent SSO via Google's session cookies.

### The solution: Playwright with persistent profile

1. **One-time setup** (`npm run auth-setup`):
   - Launches **headed** Chromium via `chromium.launchPersistentContext(".auth-state", { headless: false })`
   - User signs in with Google in the visible window
   - Script listens for the first `api2.pointsyeah.com/flight/*` request and grabs its `Authorization` header
   - Writes raw JWT to `~/.cache/pointsyeah/idToken` (mode 0600)
   - Closes browser

2. **Refresh** (`npm run auth-refresh`, also auto-fired from `ensureFreshIdToken()`):
   - **Headless** Chromium with the saved profile
   - Navigates to a search URL on pointsyeah.com
   - Page silent-SSOs via the saved Google cookie (no UI — Google's session is months-long)
   - Captures Authorization from the first `api2.pointsyeah.com` request
   - Writes to cache, closes

3. **`ensureFreshIdToken()`**: reads `~/.cache/pointsyeah/idToken`, decodes JWT exp, returns cached if `exp - now > 300s` (5 min margin), else calls `refreshIdToken()`.

### Why stealth plugin matters

Google's `gaia` login flow fingerprints Playwright's bundled Chromium and refuses OAuth (`"This browser or app may not be secure"` page). `playwright-extra` + `puppeteer-extra-plugin-stealth` patches `navigator.webdriver`, missing Chrome services, etc. Without stealth, sign-in fails.

```ts
import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
chromium.use(StealthPlugin());
```

### When the user must re-run `auth-setup`

Only when Google's session truly expires — typically 2-6 months. Symptom: a `401 Token Expired` from `api2.pointsyeah.com` that can't be auto-refreshed because Playwright comes back with no valid auth header.

### Don't

- Don't try to use Cognito refresh tokens directly. They're dead (Amplify replaces them via Google federation).
- Don't try to use the user's real Brave/Chrome via CDP unless explicitly asked. Playwright's persistent profile is self-contained and doesn't pollute their daily browser.
- Don't ask the user to paste tokens manually — that workflow is gone.

## Cash quotes (Google Flights via fast-flights)

### Why fast-flights

Google Flights has no public API. `fast-flights` (Python) drives it via base64-protobuf URLs and `selectolax` parsing.

### Per-airline filtering

Google Flights' search returns top-N (usually 13) trips by their internal ranking — not all flights of the day. For a single OD, this misses most departures. Fix: pass `airlines=["B6"]` to the FlightQuery. Google then returns up to 13 trips **for that one airline**, which usually covers all of its daily flights for short-haul (5-10 flights/day).

The TS side fires one cash query per `(date, cabin, operating-airline)` tuple seen in points results.

### IATA codes for airlines

`FlightQuery.airlines` accepts IATA 2-letter codes: `["B6"]` for JetBlue, `["AA"]`, `["DL"]`, etc. We extract these from the first-segment `flight_number` prefix (e.g., `"B61623"` → `"B6"`).

### Cabin format normalization

- **TS side** uses capitalized strings end-to-end: `"Economy" | "Premium Economy" | "Business" | "First"` (matches PointsYeah's response format and the `Cabin` type in `pointsyeah.ts`).
- **Python's `_normalize_cabin()`** maps to fast-flights' lowercase-hyphen format internally: `"economy" | "premium-economy" | "business" | "first"`.
- **Result keys** echo the original capitalized form: `"2026-06-09|Economy|B6"`.
- **Don't pre-normalize on the TS side** when sending batch entries — Python expects the capitalized form so result keys come back consistent. We hit a bug doing this; the comment in `doFlush()` documents it.

### Stdio piping is broken for large JSON output

`child.stdout` data events drop bytes when Python writes large JSON payloads — the close event can fire before the buffer drains. Confirmed via debug: Python clearly wrote and flushed, TS saw empty stdout, exit code 0.

**Fix**: round-trip results via a temp file. Pass `PY_OUT=/tmp/pointsyeah-batch-XXX.json` env var to the Python subprocess; Python writes the JSON to that file; Node reads it after `close`. See `runBatch()` in `test-search.ts`.

```ts
const outPath = path.join(os.tmpdir(), `pointsyeah-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
const child = spawn(VENV_PYTHON, [CASH_SCRIPT, "--batch"], {
  env: { ...process.env, PY_OUT: outPath },
  stdio: ["pipe", "ignore", "pipe"],
});
// ... write stdin, await close ...
const text = await fs.readFile(outPath, "utf8");
```

### `fast_flights/parser.py:34` has a stray `print(data)`

Pollutes stdout. `contextlib.redirect_stdout` is **not thread-safe** — when `asyncio.to_thread` runs concurrent `get_flights` calls, `sys.stdout` is process-global, the redirects race, and some debug spew leaks through and corrupts our JSON output.

**Fix**: monkeypatch `fast_flights.parser.print = lambda *_a, **_k: None`. Already done in `cash_quote.py` via `_silence_fast_flights_debug_print()`. **Don't remove this even if the upstream fixes the print** — the contextlib approach is fundamentally unsafe under threading.

### Concurrency cap

`asyncio.Semaphore(5)` in `_run_batch()` limits in-flight Google scrapes. Higher concurrency risks rate-limiting. Don't raise without testing.

### Disk cache

- Path: `~/.cache/pointsyeah/cash-{from}-{to}-{date}-{cabin-lowercase-hyphen}-{airline-IATA}.json`
- TTL: 1 hour (`CASH_CACHE_TTL_MS`)
- Read via `readCashCache()`, write via `writeCashCache()`
- Bypass with `--no-cache` flag

### Cash matching semantics

`matchCashForRow(r)` returns `{ trip, approximate }`:

1. **Exact match**: same departure airport + departure time within ±15 min. Display as `$X / Y¢`. Precise.
2. **Airline-cheapest fallback** (no exact time): cheapest trip from this airline+cabin+date. Display as `~$X / ~Y¢`. **This is a lower bound** — actual cash for the specific flight is at least this, possibly higher. Real CPP ≥ shown CPP. The `~` prefix is **load-bearing semantically**: green-highlighted `~` rows are still safe to act on (the deal is at least that good).

## CLI flags reference

```
Usage: npm run search -- <DEP> <ARR> <MM/DD/YYYY> [options]
       (also accepts YYYY-MM-DD)

Output is sorted cheapest-first by default. Override with --sort.
Rows with CPP ≥ 1.5¢ are highlighted as good-value awards.
CASH/CPP prefixed with ~ means a lower-bound estimate (Google didn't
return that exact departure time; we used the cheapest cash for that
airline+cabin+date as a floor — actual is at least this good).

  -c, --cabin <c>       economy | premium | business | first   (server-side)
                        repeatable; default: all
      --flex <n>        search +N days from <date> (max 60)
                        adds a DATE column. default: 0 (single day)
      --nonstop         shorthand for --max-stops 0
      --max-stops <n>   0, 1, 2…
      --max-miles <n>   e.g. 30000
      --max-tax <n>     in USD, e.g. 100
  -b, --bank <b>        amex | chase | citi | bilt | capital-one
                        repeatable; only programs transferable from these
  -p, --program <code>  UA, AA, DL, BA, …  repeatable
  -a, --airline <code>  operating airline (UA, AA, B6…)
                        strict: every segment must match
                        repeatable
  -s, --sort <field>    miles | duration | tax | departure | cpp   default: miles
                        cpp = best cents-per-point (highest first)
  -n, --limit <n>       default: all  (pass a number to truncate)
      --no-cache        bypass disk cache for cash quotes (1h TTL)
      --json            raw JSON output (skip table)
  -h, --help            show this
```

### Sort tiebreakers (durable user preference)

Every sort uses **fewer-stops then earlier-date** as tiebreakers. So between two equally-priced awards, the nonstop wins; between two same-price + same-stops, the earlier date wins. **Don't change this without asking.**

```ts
const tiebreakStops = (a: Row, b: Row) =>
  stops(a) - stops(b) || a.segments[0].dt.localeCompare(b.segments[0].dt);
```

## Render / display

### TTY vs non-TTY

- **TTY** (interactive): streaming render via ANSI cursor-up + clear-down. Re-renders on every poll change AND when cash batches complete. Header reads `t=Xs   points ✓ (N programs / M routes)   cash ✓` so you see progress live.
- **Non-TTY** (piped): single batch print at the end. No ANSI escape codes leak into the output.

`isTTY = !!process.stdout.isTTY && !values.json` in `test-search.ts` controls this.

### Column layout

Adaptive width via `pickLayout()`. Each column has `base`, `min`, `priority`. Low-priority columns (BOOK WITH, TRANSFER FROM, TIMES) drop first when terminal is narrow. `FLIES`, `MILES`, `CASH`, `CPP` have `priority: Infinity` and never drop.

DATE column appears only when `flexDays > 0`. Format: `Jun 9` short.

### Highlight

Rows with `cpp >= 1.5` get bold-green ANSI (`\x1b[1;32m`). Only emitted when `isTTY`. Don't strip the `~` prefix when checking — `cppOf()` returns the numeric value regardless.

## Performance characteristics

| Stage | Wall time | Bottleneck |
|--|--|--|
| Auth refresh (cold, stale cache) | 3-5s | Playwright Chromium cold-start |
| Auth refresh (warm cache) | 0s | Just JWT decode |
| `create_task` | 200-500ms | Their API |
| Points polling fanout (single day) | 5-30s | Their server (16 sub-tasks) |
| Points polling fanout (flex 7) | 10-60s | Same, scales with date count |
| Cash batch (4-7 airlines, parallel) | 3-8s | Google Flights scrape |
| Cash batch (cache hit) | <100ms | Just disk reads |
| Render | instant | — |

**The dominant variable is PointsYeah's own server.** Their fanout time varies from 5s to 60s for the same query depending on time of day and load. That's outside our control.

### Optimizations we've made

1. **Back-to-back polling** (50ms inter-poll interval) — server already long-polls; don't add sleep on top.
2. **Batched Python subprocess** — one spawn per render cycle instead of one per query.
3. **Filter-first cash gating** — rows excluded by `--max-miles` etc. don't trigger cash queries.
4. **Per-airline filtered queries** — exact prices for every flight that airline operates that day; lower-bound `~` semantics for off-peak times when Google's response misses them.
5. **Disk cache** keyed by `(from, to, date, cabin, airline)`, 1h TTL.

### What we can't make faster

- PointsYeah server-side fanout (5-60s, varies)
- Google Flights scrape latency (1-4s per query)
- Auth refresh cold-start (~3-5s, only on stale cache)

## Known gotchas (every bug we hit; preserve these fixes)

1. **Logged-out returns synthetic teaser data.** Auth is mandatory. Verify with `seats` field — teasers use 9999.
2. **localStorage idToken is stale.** Amplify v6 keeps fresh tokens in memory only.
3. **Cognito refresh tokens are also stale.** Google federation bypasses them; site uses silent Google SSO. Don't try to refresh via Cognito's refresh-token API.
4. **Google blocks vanilla Playwright.** `playwright-extra` + stealth plugin required. Without it, sign-in shows "Couldn't sign you in".
5. **`fast_flights/parser.py:34` has a stray `print(data)`.** `contextlib.redirect_stdout` is not thread-safe across `asyncio.to_thread` calls. Monkey-patch `fast_flights.parser.print = lambda *_a, **_k: None` instead.
6. **Stdout piping drops bytes** for large Python JSON output. Use temp file via `PY_OUT` env var.
7. **Variable shadowing**: `import path from "node:path"` collides with later `const path = (r) => ...` due to TDZ. We renamed the helper to `routePath`.
8. **Cabin string format must round-trip unchanged** through the batch protocol. Don't pre-normalize on the TS side.
9. **API validates `exp` strictly** on the idToken — expired tokens get a clean 401. The 5-min margin in `ensureFreshIdToken()` exists to avoid races.
10. **Google's response varies between calls.** Earlier we saw 13 B6 trips, later 5 for the same query. Their ranking algorithm is unstable. The `~` fallback handles this.
11. **Server returns `status: "done"`, not `"completed"`.** Both treated as terminal in the lib.
12. **Google Flights cabin filter sometimes excludes flights** even when they exist — likely a fast-flights URL/protobuf quirk. The `~` lower-bound display is the right way to handle this.

## Don't

- Don't commit `*.har` files (may carry session tokens).
- Don't commit `.auth-state/` or `.cache/` (gitignored, but worth saying).
- Don't touch `flights/` — third-party clone of AWeirdDev/flights.
- Don't add `Bearer ` prefix to the Authorization header — API rejects it.
- Don't pre-normalize cabin strings on the TS side before sending to Python.
- Don't widen `--flex` window without warning the user (cash queries scale with date × cabin × airline).
- Don't add `setTimeout` between `fetch_result` polls — server long-polls, you're just adding dead time.
- Don't assume Google Flights will return a specific time slot — handle `~` fallback gracefully.
- Don't recommend "headless" approaches like browser-use until the Next.js app is deployed somewhere; for local CLI, Playwright + stealth is the right answer.

## User's durable preferences

- **TypeScript / Next.js / Vercel for frontend; Railway for backend.** From their global CLAUDE.md.
- **Backend uses Supabase, not Railway DB.** From global CLAUDE.md (no DB used yet, but if we add one).
- **Always bind servers to 0.0.0.0** and read `PORT` from env (Railway).
- **Sort default: miles asc, with stops + date as tiebreakers** (cheapest then nonstop then earliest).
- **Show all results by default**; `--limit N` is opt-in.
- **Date input: MM/DD/YYYY** (with YYYY-MM-DD as fallback).
- **Confirm which file/page to modify before changing it** — don't touch unrelated files.
- **No comments unless they explain non-obvious why.** Don't restate what code does.
- **Minimal targeted edits.** Don't refactor surrounding code as a side effect.
- **Defaults for verdicts/highlights**: ≥1.5¢ CPP highlighted green; below = no highlight.

## What's done (cumulative feature list)

1. Encrypted PointsYeah API client + auto-merge polling
2. Cash integration via fast-flights subprocess
3. CPP column + ≥1.5¢ highlights (TTY-only ANSI)
4. CLI filters: `--cabin --nonstop --max-stops --max-miles --max-tax --bank --program --airline` (strict)
5. Sort options: `miles | duration | tax | departure | cpp` with stops + date tiebreakers
6. Streaming render (TTY-only, ANSI clear-and-redraw)
7. Disk cache for cash with 1h TTL
8. Playwright + stealth auto-refresh of idTokens
9. `--flex N` multi-day search with DATE column (up to 60 days; server supports it)
10. Per-airline filtered cash queries (lower-bound semantics; precise CPP for exact matches)
11. Batched Python subprocess (`--batch`) — single spawn per render cycle
12. Filter-first gating — only fetch cash for rows that pass user filters

## What's NOT done (planned)

### Next planned: Watch mode

User wants this next. Concept:
```bash
pointsyeah watch JFK NRT 6/15/2026 --max-miles 80000 --cabin business
```
Polls every N minutes, sends a desktop notification when a matching award appears. Replicates PointsYeah's paid alerts feature for personal use.

Open design questions to discuss with the user when starting this:
- Polling interval default? (suggest 15-30 min)
- Notification mechanism: macOS native (`node-notifier`), Slack/Discord webhook, email, or all three?
- How does watch mode interact with the cash-queries layer? — probably skip cash entirely on poll; only fire when a match appears
- Persistence: where do active watches live? (`~/.config/pointsyeah/watches.json`?) Survive restarts?
- Multi-watch support: should one process babysit many watches concurrently?
- Trigger condition: any new award meeting filters, OR price-drop on a previously-seen one?
- Daemon vs cron-fired one-shot vs `npm run watch -- ...` foreground process? launchd plist if persistent?

### Other deferred ideas

- **Per-program verdict labels** (STEAL/GOOD/MEH/SKIP) using per-program CPP baselines (AA 1.4, UR 2.0, Aeroplan 1.5, BA 1.5, Delta 1.1). Small effort, high signal.
- **Sweet-spot library** — curated JSON of known great award rates (Aeroplan JFK→FRA business 70K, etc.). Adds expert intelligence.
- **Round-trip search** — `search_type: "round_trip"` in encrypted payload. Biggest functional gap; most real bookings are RT.
- **Multi-city / nearby airports** — JFK+EWR+LGA together for NYC.
- **My-cards config** — `~/.pointsyeahrc` defaults to user's transfer partners.
- **Direct booking instructions** column — "Transfer 15K Chase UR → United, then book at <url>".
- **Local price history** — log every search to SQLite; surface trends.
- **Cabin-upgrade math** — "Y is 12K, J is 88K — paying 76K for the upgrade".
- **Next.js scaffold** — the destination. Port `pointsyeah.ts` and auth into route handlers, run Playwright on Railway.

## Useful diagnostic commands

```bash
# Smoke test the API end-to-end:
npm run search -- JFK LAX 6/9/2026 --cabin economy --limit 5

# Probe multi-day API support:
npx tsx scripts/test-flex.ts

# Manual cash batch test (writes to stdout when no PY_OUT env):
echo '[{"from":"JFK","to":"LAX","date":"2026-06-09","cabin":"Economy","airlines":["B6"]}]' | \
  .venv/bin/python scripts/cash_quote.py --batch

# Inspect cached cash for a specific airline:
cat ~/.cache/pointsyeah/cash-JFK-LAX-2026-06-09-economy-B6.json | jq

# Force token refresh:
rm ~/.cache/pointsyeah/idToken && npm run search -- JFK LAX 6/9/2026

# Dump raw fetch_result snapshots (helpful for debugging response shape):
npx tsx scripts/dump-response.ts
# → /tmp/py-dump.json

# Type-check without compiling:
npx tsc --noEmit
# (Will show "missing @types/node" errors — these are noise; tsx ignores types and runs fine.)
```

## Style conventions in this codebase

- **ESM** (`"type": "module"` in package.json). Top-level await is fine.
- **Imports use `.ts` extensions** (`from "./auth.ts"`) because of `allowImportingTsExtensions` in tsconfig.
- **No explicit `@types/node`.** Project intentionally lean. Type errors that say "Cannot find module 'node:fs/promises'" or "Cannot find name 'process'" are pre-existing noise — ignore them. tsx runs the code fine.
- **Comments are sparse.** When present, they explain *why* (non-obvious constraint, gotcha, user preference) — never *what*. Don't add comments restating what code does.
- **Don't add backwards-compat shims** for removed code. If something's gone, it's gone.
- **No emojis in code** unless explicitly requested. Output formatting may use UTF-8 chars (✓, …, ↑, →) sparingly when they communicate something.

## When in doubt

- **Read the user's global CLAUDE.md** at `~/.claude/CLAUDE.md` for style rules that override defaults.
- **Look at git history** for context on recent decisions.
- **Ask before destructive actions** (rm -rf, force push, migration changes).
- **Trust but verify subagent reports** — re-read files they claim to have changed.
- **The PointsYeah backend will sometimes act weird.** Empty results, slow responses, server errors — usually transient. Retry once before assuming a code regression.
