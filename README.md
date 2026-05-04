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
# 1. Install Node deps
npm install

# 2. Set up Python venv for the cash-price side
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 3. (Optional, recommended) Add your pointsyeah idToken
cp .env.example .env
# then edit .env — see comments inside for how to grab the token from your browser
```

Without a token the pointsyeah API returns synthetic teaser data; with one you get real award availability.

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

### `src/test-search.ts`
Argument parsing, filtering, sorting, and table rendering. Fans out one `cash_quote.py` subprocess per requested cabin in parallel with the points polling, so cash and award data arrive concurrently. As points results stream in, each frame redraws the table in place (TTY only) so you watch programs populate live.

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
  test-search.ts       # the CLI
  dump-response.ts     # debug helper: dumps raw poll snapshots to /tmp
scripts/
  cash_quote.py        # Google Flights subprocess
.env.example           # template for the pointsyeah idToken
requirements.txt       # Python deps (fast-flights from GitHub)
package.json           # Node deps (just tsx + typescript)
```

## License

MIT for the code in this repo. Note that `fast-flights` is MIT-licensed as well, but is not vendored — it's installed from its GitHub source via `requirements.txt`.
