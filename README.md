# pointsyeah-cli

A terminal flight search that prints **points/miles awards side-by-side with cash prices** for the same route — and computes the **cents-per-point (CPP)** redemption value of every award so you can tell the great deals from the bad ones at a glance.

- **Awards side**: a reverse-engineered client for [pointsyeah.com](https://www.pointsyeah.com)'s search API. Aggregates award availability across dozens of frequent-flyer programs and tells you which transferable-points banks (Amex, Chase, Citi, Bilt, Capital One) can move points into each program.
- **Cash side**: Google Flights data via the open-source [`fast-flights`](https://github.com/AWeirdDev/flights) Python library, called as a subprocess. Cached on disk for 1h so re-running searches is instant.
- **CPP**: for each award, finds the closest cash trip on the same route + departure (within 15 minutes) and computes `(cash_price − taxes) / miles × 100`. Awards with CPP ≥ 1.5¢ are highlighted in green. Sort by `-s cpp` to see the best-value redemptions first.
- **Live streaming**: results render as they arrive. The pointsyeah API long-polls in batches, so you see programs populate the table in real time while cash queries fan out in parallel.

> ⚠️ This is a personal/educational project. The pointsyeah.com endpoints aren't a public API — usage is at your own risk and subject to their terms of service.

## Example

After a one-time `npm run auth-setup`, every search refreshes its token automatically:

```
$ npm run search -- LAX PHL 06/09/2026 -c business --nonstop -s cpp -n 5

Auth: logged in (parseKeySection=a3f9c1d2, expired=false)
Searching LAX → PHL on 06/09/2026 (cabins: Business)…

t=4.2s   points ✓ (12 programs / 38 routes)   cash ✓
cash baseline: business from $612

FLIES     FLIGHT#         TIMES           ROUTE           DUR    CABIN            MILES     +TAX     CASH     CPP  BOOK WITH                   TRANSFER FROM
-----------------------------------------------------------------------------------------------------------------------------------------------------------
AA        AA1132          10:36a-6:54p    LAX-PHL         5h18   Business        43,600    $5.60    $612   1.39¢  Qantas Frequent Flyer       Capital One, Amex, Citi
AA        AA513           3:05p-11:18p    LAX-PHL         5h13   Business        43,600    $5.60    $658   1.50¢  Qantas Frequent Flyer       Capital One, Amex, Citi
…

Showing 5 of 38 returned (12 programs, sorted by cpp).
```

`CPP` is cents per point — higher is better. The bold-green rows in your terminal are the ≥1.5¢ "good redemption" picks. The status line above the table updates live as both sides stream in (`points …` → `points ✓`).

### Narrow terminals

The table reflows to fit. Resize your terminal mid-search and the next streaming frame redraws with fewer/narrower columns. At ~100 cols the lowest-priority columns (ROUTE, CABIN, DUR) drop out first; the `MILES`/`CASH`/`CPP` triple is always kept since it's the whole point of the comparison:

```
FLIES     FLIGHT#         TIMES            MILES     +TAX     CASH     CPP  BOOK WITH                  TRANSFER FROM
-------------------------------------------------------------------------------------------------------------------
AA        AA1132          10:36a-6:54p    43,600    $5.60    $612   1.39¢  Qantas Frequent Flyer       Capital On…
AA        AA513           3:05p-11:18p    43,600    $5.60    $658   1.50¢  Qantas Frequent Flyer       Capital On…
```

## Setup

Requires **Node 22+** and **Python 3.10+**. First-time setup runs an interactive Google sign-in once on a machine with a desktop; after that, everything is headless.

```bash
# 1. Clone
git clone https://github.com/farzanariel/pointsyeah-cli.git
cd pointsyeah-cli

# 2. Install Node deps + Playwright Chromium (~150MB)
npm install
npx playwright install chromium
# On Linux you may also need: npx playwright install-deps chromium

# 3. Set up Python venv for the cash-price side
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 4. One-time Google sign-in — opens a Chromium window
npm run auth-setup

# 5. Run a search
npm run search -- JFK LAX 06/09/2026 -c economy --nonstop
```

`auth-setup` writes a portable `auth.json` (Cognito refresh-token state) to the repo root. **It's gitignored — never commit it.** Subsequent searches reuse a cached short-lived JWT (`~/.cache/pointsyeah/idToken`); when that JWT expires (~1h), the CLI silently mints a new one from `auth.json` via headless Playwright.

> If `auth-setup` just sits there after you sign in, run a flight search on the page — that triggers the auth'd API call the script listens for.

You only need to re-run `auth-setup` when the Cognito refresh token expires (~30 days, but it's silently rotated on each headless refresh — so in practice, only when you've gone a month without using the tool).

### Running the MCP server

The repo also exposes an MCP server so MCP-compatible clients (Claude Code, etc.) can call the same search engine:

```bash
npm run mcp
```

Same auth setup — `auth-setup` first, then start the server.

### Running on a VPS / datacenter

A headless VPS can't run the interactive Google sign-in. Workflow: run `auth-setup` on a desktop, sync `auth.json` to the VPS, point the tools at it via env var.

```bash
# On your laptop:
npm run auth-setup
scp auth.json vps-user@vps-host:~/secrets/pointsyeah-auth.json

# On the VPS:
export POINTSYEAH_AUTH_PATH=~/secrets/pointsyeah-auth.json
npm run search -- JFK LAX 06/09/2026
```

`POINTSYEAH_AUTH_PATH` overrides the default `./auth.json` lookup for `auth-setup`, `auth-refresh`, and the MCP server. Storing the file outside the repo means it can't accidentally be re-committed. The VPS handles its own hourly idToken refreshes from there.

The repo ships an `npm run sync-auth` helper for the laptop side: it reads `POINTSYEAH_SYNC_TARGET` (and optionally `POINTSYEAH_AUTH_PATH`) from `.env` and `scp`s. Add to your gitignored `.env`:

```
POINTSYEAH_SYNC_TARGET=vps-user@vps-host:~/secrets/pointsyeah-auth.json
```

Then `npm run sync-auth` after each `auth-setup`.

Two other things behave differently on datacenter IPs:

- **Pointsyeah API**: works fine — `auth-refresh` from `auth.json` succeeds with no proxy.
- **Google Flights (cash side)**: serves a different (unparseable) page to datacenter IPs. You need a residential proxy:
  ```bash
  export POINTSYEAH_PROXY='http://user:pass@residential-proxy.example:1234'
  ```
  Read by both `auth-refresh.ts` and `cash_quote.py`.

A pre-baked wrapper that exports both env vars and forwards args is convenient for agents:

```bash
#!/usr/bin/env bash
# run.sh
export POINTSYEAH_AUTH_PATH=$HOME/secrets/pointsyeah-auth.json
export POINTSYEAH_PROXY='http://user:pass@host:port'
cd "$(dirname "$0")"
exec npm run --silent search -- "$@"
```

## Authentication internals

- **`auth.json`** (gitignored, per-user): a Playwright [`storageState`](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state) JSON containing decrypted cookies for `www.pointsyeah.com` — including the AWS Cognito `refreshToken` (~30 day TTL), `idToken`, `accessToken`, and `LastAuthUser`. **This is your credential — anyone with this file is signed in as you.** Path overridable via `POINTSYEAH_AUTH_PATH`.
- **`~/.cache/pointsyeah/idToken`** (gitignored, mode 0600): the short-lived (~1h) JWT used to authorize each API call. The CLI re-mints this from `auth.json` whenever it's within 5 min of expiring.
- **`.auth-state/`** (gitignored): Playwright's persistent Chromium profile from `auth-setup`. Used only on the machine that ran `auth-setup`. Not portable — Chromium encrypts cookie values with the host OS keyring (Keychain / Secret Service), so the encrypted blob is unreadable on any other machine. That's why we extract a portable `auth.json` instead.

### Why a refresh token instead of just a JWT?

A JWT lasts ~1 hour. A Cognito `refreshToken` (what's in `auth.json`) lasts ~30 days and is silently rotated on each refresh, so once `auth-setup` runs, the tool stays usable for a month at a time with no further interaction.

### Manual refresh

```bash
npm run auth-refresh   # mints a new idToken from auth.json
```

If you ever see `Auth not set up. Run: npm run auth-setup`, the refresh token has expired or been revoked — re-run `auth-setup` (on a machine with a desktop) and, if you're on a VPS, re-sync `auth.json`.

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
