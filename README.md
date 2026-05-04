# pointsyeah-cli

A terminal flight search that prints **points/miles awards side-by-side with cash prices** for the same route — and computes the **cents-per-point (CPP)** redemption value of every award so you can tell the great deals from the bad ones at a glance.

- **Awards side**: a reverse-engineered client for [pointsyeah.com](https://www.pointsyeah.com)'s search API. Aggregates award availability across dozens of frequent-flyer programs and tells you which transferable-points banks (Amex, Chase, Citi, Bilt, Capital One) can move points into each program.
- **Cash side**: Google Flights data via the open-source [`fast-flights`](https://github.com/AWeirdDev/flights) Python library, called as a subprocess. Cached on disk for 1h so re-running searches is instant.
- **CPP**: for each award, finds the closest cash trip on the same route + departure (within 15 minutes) and computes `(cash_price − taxes) / miles × 100`. Awards with CPP ≥ 1.5¢ are highlighted in green. Sort by `-s cpp` to see the best-value redemptions first.
- **Live streaming**: results render as they arrive. The pointsyeah API long-polls in batches, so you see programs populate the table in real time while cash queries fan out in parallel.

> ⚠️ This is a personal/educational project. The pointsyeah.com endpoints aren't a public API — usage is at your own risk and subject to their terms of service.

## Example

```
$ npm run search -- LAX PHL 06/09/2026 -c business --nonstop -s cpp -n 5

t=4.2s   points ✓ (12 programs / 38 routes)   cash ✓
cash baseline: business from $612

FLIES     FLIGHT#         TIMES           ROUTE           DUR    CABIN            MILES     +TAX     CASH    CPP  BOOK WITH                   TRANSFER FROM
----------------------------------------------------------------------------------------------------------------------------------------------------------
AA        AA1132          10:36a-6:54p    LAX-PHL         5h18   Business        43,600    $5.60    $612  1.39¢  Qantas Frequent Flyer       Capital One, Amex, Citi
AA        AA513           3:05p-11:18p    LAX-PHL         5h13   Business        43,600    $5.60    $658  1.50¢  Qantas Frequent Flyer       Capital One, Amex, Citi
…
```

`CPP` is cents per point — higher is better. The bold-green rows in your terminal are the ≥1.5¢ "good redemption" picks.

## Setup

Requires **Node 22+** (for `process.loadEnvFile` and the native `tsx` ESM loader) and **Python 3.10+**.

```bash
# 1. Install Node deps (this also installs Playwright, used by auth-setup)
npm install
npx playwright install chromium

# 2. Set up Python venv for the cash-price side
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. Sign in to pointsyeah once — see "Authentication" below
npm run auth-setup
```

Without authentication the pointsyeah API returns synthetic teaser data; once signed in you get real award availability.

## Authentication

pointsyeah authenticates every API request with a short-lived (~1 hour) Firebase ID token. This CLI takes a browser-automation approach to handle that without any manual copy-paste:

### One-time setup

```bash
npm run auth-setup
```

This launches a Chromium window via Playwright. Sign in to [pointsyeah.com](https://www.pointsyeah.com) however you normally do (Google sign-in works). Once the script captures an authenticated request to `api2.pointsyeah.com` it saves your token to `~/.cache/pointsyeah/idToken` (mode `0600`) and your browser profile to `./.auth-state/`. The window closes automatically.

> **Tip:** if the script just sits there after you finish signing in, run a flight search on the page — that's what triggers the API call it's listening for.

### Auto-refresh on expiry

After the one-time setup, **you don't have to do anything else**. Before each search the CLI:

1. Reads the cached token from `~/.cache/pointsyeah/idToken`.
2. Decodes the JWT's `exp` claim. If the token is still valid (>5 minutes from expiry), it's used as-is.
3. If it's expired or about to expire, a **headless** Playwright session loads the saved profile, hits a search URL, captures the fresh authenticated request, and writes the new token to disk. This typically takes a few seconds and only happens once per session.

If your saved browser profile gets logged out (cookies expired, password reset, etc.), you'll see `Auth not set up. Run: npm run auth-setup` — just re-run the one-time setup and you're back.

### Manual refresh

If you want to force a refresh without waiting for the next search:

```bash
npm run auth-refresh
```

### Files written to disk

| Path | What | Why it's gitignored |
|---|---|---|
| `~/.cache/pointsyeah/idToken` | the active JWT (mode 0600) | sensitive — outside the repo entirely |
| `./.auth-state/` | Playwright's persistent Chromium profile (cookies, localStorage) | sensitive — keeps you logged in |

Both are already in `.gitignore`. Treat them like a password.

## Usage

```bash
npm run search -- <DEP> <ARR> <MM/DD/YYYY> [options]
# accepts YYYY-MM-DD too
```

### Options

| Flag | Description |
|---|---|
| `-c, --cabin <c>` | `economy` \| `premium` \| `business` \| `first` (repeatable) |
| `--nonstop` | shorthand for `--max-stops 0` |
| `--max-stops <n>` | filter on connections |
| `--max-miles <n>` | upper bound on award cost |
| `--max-tax <n>` | upper bound on cash co-pay (USD) |
| `-b, --bank <b>` | only show programs transferable from `amex` \| `chase` \| `citi` \| `bilt` \| `capital-one` (repeatable) |
| `-p, --program <code>` | filter by award program code (e.g. `UA`, `AA`, `BA`) |
| `-a, --airline <code>` | filter by operating carrier — every segment must match |
| `-s, --sort <field>` | `miles` (default) \| `duration` \| `tax` \| `departure` \| `cpp` (best redemption value first) |
| `-n, --limit <n>` | truncate results; default shows all |
| `--no-cache` | bypass the 1h disk cache for cash quotes |
| `--json` | raw JSON instead of the table |

## How it works

### `src/pointsyeah.ts`
The pointsyeah web app encrypts its search payloads with AES-256-CBC before sending them. The key is built by sandwiching an 8-character "key section" between two static halves and base64-decoding the result. For logged-out sessions the key section is hardcoded; for logged-in sessions it's the first 8 characters of the JWT's `jti` claim. The constants in this file were reverse-engineered from a single bundled JS chunk on the site.

The search itself is a two-step long-poll: `POST /flight/search/create_task` returns a task id, then `POST /flight/search/fetch_result` is called repeatedly until status flips to `done`. Each poll merges any new program results into a map keyed by `program|date|origin|dest` so refreshes don't duplicate.

### `src/auth.ts` + `scripts/auth-setup.ts` + `scripts/auth-refresh.ts`
The auth pipeline. `auth-setup` is the interactive one-time browser sign-in that captures the first token and persists a Chromium profile. `auth-refresh` is the headless re-run that uses that profile to mint a fresh token whenever the cached one is within 5 minutes of expiry. `src/auth.ts`'s `ensureFreshIdToken()` is what the CLI calls before every search — it transparently picks between the cached token and a refresh.

### `src/test-search.ts`
Argument parsing, filtering, sorting, and table rendering. Calls `ensureFreshIdToken()` first, then fans out one `cash_quote.py` subprocess per requested cabin in parallel with the points polling, so cash and award data arrive concurrently. As points results stream in, each frame redraws the table in place (TTY only) so you watch programs populate live. The table layout is width-aware: it drops less-essential columns and shrinks shrinkable ones to fit the current terminal width.

**Cash matching.** For each award row, the CLI looks for a cash trip in the same cabin that:
1. departs from the same origin airport (matters for multi-segment awards), and
2. departs within ±15 minutes of the award's first segment.

The closest match by departure time wins. If nothing's within 15 minutes the row shows `—` for both `CASH` and `CPP`.

**CPP** = `(cash_price − taxes) / miles × 100`, expressed in cents. Subtracting taxes keeps the math honest — you'd pay them on either side, so they shouldn't inflate the value of the points. Awards ≥ 1.5¢/point render in bold green.

### `scripts/cash_quote.py`
Thin wrapper over `fast-flights` that prints a JSON list of trips to stdout — designed to be called as a subprocess by the Node CLI. Caches results per `(origin, dest, date, cabin)` for 1 hour to make repeat searches instant; bypass with `--no-cache`.

## Project layout

```
src/
  pointsyeah.ts        # the encrypted-API client
  auth.ts              # picks between cached token and refresh
  test-search.ts       # the CLI
  dump-response.ts     # debug helper: dumps raw poll snapshots to /tmp
scripts/
  auth-setup.ts        # interactive Playwright sign-in (one-time)
  auth-refresh.ts      # headless token refresh (auto + manual)
  cash_quote.py        # Google Flights subprocess
requirements.txt       # Python deps (fast-flights from GitHub)
package.json           # Node deps: tsx, typescript, playwright + stealth
```

Cache + state (gitignored, lives outside the repo or in `.auth-state/`):

```
~/.cache/pointsyeah/idToken   # current JWT, mode 0600
./.auth-state/                # Playwright persistent Chromium profile
./.cache/                     # Python-side cache for cash_quote.py
```

## License

MIT for the code in this repo. Note that `fast-flights` is MIT-licensed as well, but is not vendored — it's installed from its GitHub source via `requirements.txt`.
