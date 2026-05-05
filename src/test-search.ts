import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  search,
  getAuthContext,
  type Cabin,
  type ProgramResult,
  type Route,
} from "./pointsyeah.ts";
import { ensureFreshIdToken } from "./auth.ts";

const execFileP = promisify(execFile);
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv/bin/python");
const CASH_SCRIPT = path.join(PROJECT_ROOT, "scripts/cash_quote.py");
const CACHE_DIR = path.join(os.homedir(), ".cache/pointsyeah");
const CASH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CPP_HIGHLIGHT = 1.5;

const FAST_FLIGHTS_CABIN: Record<Cabin, string> = {
  Economy: "economy",
  "Premium Economy": "premium-economy",
  Business: "business",
  First: "first",
};

interface CashTrip {
  price: number;
  airlines: string[];
  stops: number;
  duration_minutes: number;
  departure: string;
  arrival: string;
  from: string;
  to: string;
}

function cacheFileFor(
  dep: string,
  arr: string,
  date: string,
  cabin: Cabin,
  airline: string,
): string {
  const safeCabin = cabin.toLowerCase().replace(/\s+/g, "-");
  return path.join(
    CACHE_DIR,
    `cash-${dep}-${arr}-${date}-${safeCabin}-${airline}.json`,
  );
}

async function readCashCache(file: string): Promise<CashTrip[] | null> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > CASH_CACHE_TTL_MS) return null;
    return JSON.parse(await fs.readFile(file, "utf8")) as CashTrip[];
  } catch {
    return null;
  }
}

async function writeCashCache(file: string, trips: CashTrip[]): Promise<void> {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(trips));
  } catch {
    /* cache write failure is non-fatal */
  }
}

// Single-query cash fetch is no longer used by the live flow — batch + per-
// airline filtering replaces it. Kept for any external scripts that import
// it. Pinned to the new cache-file shape; airline arg required.
async function fetchCashQuotes(
  dep: string,
  arr: string,
  date: string,
  cabin: Cabin,
  airline: string,
  useCache: boolean,
): Promise<CashTrip[]> {
  const file = cacheFileFor(dep, arr, date, cabin, airline);
  if (useCache) {
    const cached = await readCashCache(file);
    if (cached) return cached;
  }
  try {
    const { stdout } = await execFileP(
      VENV_PYTHON,
      [CASH_SCRIPT, "--from", dep, "--to", arr, "--date", date, "--cabin", FAST_FLIGHTS_CABIN[cabin]],
      { maxBuffer: 50 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    if (!parsed.ok) return [];
    const trips = parsed.trips as CashTrip[];
    if (useCache) await writeCashCache(file, trips);
    return trips;
  } catch {
    return [];
  }
}

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env — fine, will run logged-out */
}

const HELP = `\
Usage: npx tsx src/test-search.ts <DEP> <ARR> <MM/DD/YYYY> [options]
   or: npm run search -- <DEP> <ARR> <MM/DD/YYYY> [options]
   (also accepts YYYY-MM-DD)

Output is sorted cheapest-first by default. Override with --sort.
Rows with CPP ≥ ${CPP_HIGHLIGHT}¢ are highlighted as good-value awards.
CASH/CPP prefixed with ~ means an airline-level estimate (Google didn't
return that exact departure time; we used the cheapest cash for that
airline+cabin+date as an anchor).

Options:
  -c, --cabin <c>       economy | premium | business | first   (server-side)
                        repeatable; default: all
      --flex <n>        search +N days from <date> (max ~7).
                        adds a DATE column. default: 0 (single day)
      --nonstop         only direct flights (exactly 0 stops)
      --one-stop        only 1-stop itineraries (exactly 1 stop)
      --max-stops <n>   include up to N stops (0 = nonstop, 1 = nonstop+1-stop…)
      --max-miles <n>   e.g. 30000
      --max-tax <n>     in USD, e.g. 100
  -b, --bank <b>        amex | chase | citi | bilt | capital-one
                        repeatable; only programs transferable from these
  -p, --program <code>  UA, AA, DL, BA, …  repeatable
  -a, --airline <code>  operating airline (UA, AA, B6…)
                        strict: every segment must match
                        repeatable
      --aircraft <s>    aircraft type substring (787, a350, 777-300…)
                        case-insensitive; every segment must match one
                        repeatable
  -s, --sort <field>    miles | duration | tax | departure | cpp   default: miles
                        cpp = best cents-per-point (highest first)
  -n, --limit <n>       default: all  (pass a number to truncate)
  -r, --return <date>   return date (MM/DD/YYYY or YYYY-MM-DD); enables round-trip search
      --no-cache        bypass disk cache for cash quotes (1h TTL)
      --json            raw JSON output (skip table)
  -h, --help            show this
`;

let parsed;
try {
  parsed = parseArgs({
    options: {
      cabin: { type: "string", multiple: true, short: "c" },
      flex: { type: "string" },
      nonstop: { type: "boolean" },
      "one-stop": { type: "boolean" },
      "max-stops": { type: "string" },
      "max-miles": { type: "string" },
      "max-tax": { type: "string" },
      bank: { type: "string", multiple: true, short: "b" },
      program: { type: "string", multiple: true, short: "p" },
      airline: { type: "string", multiple: true, short: "a" },
      aircraft: { type: "string", multiple: true },
      sort: { type: "string", short: "s", default: "miles" },
      limit: { type: "string", short: "n" },
      return: { type: "string", short: "r" },
      "no-cache": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
} catch (e) {
  console.error(`Bad args: ${(e as Error).message}\n\n${HELP}`);
  process.exit(1);
}
const { values, positionals } = parsed;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const [dep, arr, dateRaw] = positionals;
const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function normalizeDate(s: string | undefined): string | null {
  if (!s) return null;
  if (ISO_DATE.test(s)) return s;
  const m = s.match(US_DATE);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

const date = normalizeDate(dateRaw);
if (!dep || !arr || !date || !IATA.test(dep) || !IATA.test(arr)) {
  console.error(
    `Need <DEP> <ARR> <MM/DD/YYYY> as positional args.\n` +
      `Got: dep=${JSON.stringify(dep)} arr=${JSON.stringify(arr)} date=${JSON.stringify(dateRaw)}\n\n${HELP}`,
  );
  process.exit(1);
}

const returnDate = normalizeDate(values.return as string | undefined);
if (values.return !== undefined && !returnDate) {
  console.error(`Invalid --return date: "${values.return}". Expected MM/DD/YYYY or YYYY-MM-DD.`);
  process.exit(1);
}

const CABIN_ALIASES: Record<string, Cabin> = {
  economy: "Economy",
  e: "Economy",
  y: "Economy",
  premium: "Premium Economy",
  "premium-economy": "Premium Economy",
  pe: "Premium Economy",
  w: "Premium Economy",
  business: "Business",
  biz: "Business",
  j: "Business",
  c: "Business",
  first: "First",
  f: "First",
};

function normalizeCabin(s: string): Cabin {
  const c = CABIN_ALIASES[s.trim().toLowerCase()];
  if (!c) {
    console.error(`Unknown cabin "${s}". Try: economy | premium | business | first`);
    process.exit(1);
  }
  return c;
}

const cabins = values.cabin?.length ? [...new Set(values.cabin.map(normalizeCabin))] : undefined;

// Upper bound is what the PointsYeah API itself accepts; their UI exposes 8 to
// paid users. Clamp at 60 just to keep us from accidentally firing 240+ cash
// queries (4 cabins × 60 days). Whether the API actually returns data past day
// 8 is what `--flex` lets you probe.
const flexDays = values.flex !== undefined ? Math.max(0, Math.min(60, Number(values.flex))) : 0;
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const departDateTo = flexDays > 0 ? addDays(date!, flexDays) : undefined;

// `--nonstop` and `--one-stop` are exact-match shorthands; `--max-stops N`
// is a range. They're independent: e.g. `--max-stops 2` paired with
// `--one-stop` would be redundant (the latter wins), but neither breaks.
const exactStops: number | undefined = values.nonstop
  ? 0
  : values["one-stop"]
    ? 1
    : undefined;
const maxStops =
  values["max-stops"] !== undefined ? Number(values["max-stops"]) : undefined;
const maxMiles = values["max-miles"] !== undefined ? Number(values["max-miles"]) : undefined;
const maxTax = values["max-tax"] !== undefined ? Number(values["max-tax"]) : undefined;

function normalizeBank(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]/g, "");
}
const bankFilter = values.bank?.length ? new Set(values.bank.map(normalizeBank)) : null;
const programFilter = values.program?.length
  ? new Set(values.program.map((s) => s.toUpperCase()))
  : null;
const airlineFilter = values.airline?.length
  ? new Set(values.airline.map((s) => s.toUpperCase()))
  : null;
const aircraftFilter = values.aircraft?.length
  ? values.aircraft.map((s) => s.trim().toLowerCase()).filter(Boolean)
  : null;

interface Row extends Route {
  programName: string;
  programCode: string;
  leg: "outbound" | "return";
}

const stops = (r: Row) => r.segments.length - 1;
const operatingCarriers = (r: Row): Set<string> =>
  new Set(r.segments.map((s) => s.flight_number.match(/^[A-Z0-9]{2}/)?.[0] ?? "??"));

function passesFilters(r: Row): boolean {
  if (exactStops !== undefined && stops(r) !== exactStops) return false;
  if (maxStops !== undefined && stops(r) > maxStops) return false;
  if (maxMiles !== undefined && r.payment.miles > maxMiles) return false;
  if (maxTax !== undefined && r.payment.tax > maxTax) return false;
  if (programFilter && !programFilter.has(r.programCode.toUpperCase())) return false;
  if (airlineFilter) {
    const carriers = operatingCarriers(r);
    if (![...carriers].every((c) => airlineFilter.has(c))) return false;
  }
  if (aircraftFilter) {
    const allMatch = r.segments.every((s) => {
      const a = (s.aircraft ?? "").toLowerCase();
      return aircraftFilter.some((needle) => a.includes(needle));
    });
    if (!allMatch) return false;
  }
  if (bankFilter) {
    const banks = (r.transfer ?? []).map((t) => normalizeBank(t.code || t.bank));
    if (!banks.some((b) => bankFilter.has(b))) return false;
  }
  return true;
}

// Tiebreakers: nonstops above connections, then earlier dates above later dates.
const tiebreakStops = (a: Row, b: Row) =>
  stops(a) - stops(b) || a.segments[0].dt.localeCompare(b.segments[0].dt);
const cppOf = (r: Row): number | null => {
  const m = matchCashForRow(r);
  if (!m || r.payment.miles <= 0) return null;
  return ((m.trip.price - r.payment.tax) / r.payment.miles) * 100;
};
const SORTS: Record<string, (a: Row, b: Row) => number> = {
  miles: (a, b) => a.payment.miles - b.payment.miles || tiebreakStops(a, b),
  duration: (a, b) => a.duration - b.duration || tiebreakStops(a, b),
  tax: (a, b) => a.payment.tax - b.payment.tax || tiebreakStops(a, b),
  departure: (a, b) => a.segments[0].dt.localeCompare(b.segments[0].dt) || tiebreakStops(a, b),
  // CPP: higher is better. Rows with no cash match sink to the bottom.
  cpp: (a, b) => {
    const ca = cppOf(a);
    const cb = cppOf(b);
    if (ca == null && cb == null) return tiebreakStops(a, b);
    if (ca == null) return 1;
    if (cb == null) return -1;
    return cb - ca || tiebreakStops(a, b);
  },
};
const sortFn = SORTS[values.sort!];
if (!sortFn) {
  console.error(`Unknown --sort "${values.sort}". Try: ${Object.keys(SORTS).join(" | ")}`);
  process.exit(1);
}
const limit =
  values.limit === undefined || values.limit.toLowerCase() === "all"
    ? Infinity
    : Math.max(1, Number(values.limit));

const useCache = !values["no-cache"];
// Keyed by `${YYYY-MM-DD}|${Cabin}|${airline-IATA}` so each (date, cabin,
// operating-airline) tuple gets its own bucket. Per-airline filtering at
// query time gives us exact prices for every flight that airline operates
// on that date — no more "cheapest-of-day" misleading fallbacks.
const cashByDateCabinAirline = new Map<string, CashTrip[]>();
const cashKey = (from: string, to: string, d: string, c: Cabin, a: string) => `${from}|${to}|${d}|${c}|${a}`;
const firstSegmentAirline = (r: Row): string | undefined =>
  r.segments[0].flight_number.match(/^[A-Z0-9]{2}/)?.[0];

interface CashMatch {
  trip: CashTrip;
  approximate: boolean; // true when we couldn't find an exact-time match within
  // the airline's same-day results and fell back to its cheapest of the day.
}

function matchCashForRow(r: Row): CashMatch | undefined {
  const rowDate = r.segments[0].dt.slice(0, 10);
  const cabin = r.payment.cabin as Cabin;
  const airline = firstSegmentAirline(r);
  if (!airline) return undefined;

  const from = r.segments[0].da;
  const to = r.segments[r.segments.length - 1].aa;
  const trips = cashByDateCabinAirline.get(cashKey(from, to, rowDate, cabin, airline));
  if (!trips?.length) return undefined;

  const seg0 = r.segments[0];
  const rowDep = new Date(seg0.dt).getTime();

  // 1) Exact time match: same departure airport, ±15 min.
  let bestExact: CashTrip | undefined;
  let bestDiff = Infinity;
  for (const t of trips) {
    if (t.from !== seg0.da) continue;
    const diff = Math.abs(new Date(t.departure).getTime() - rowDep);
    if (diff < bestDiff && diff <= 15 * 60 * 1000) {
      bestDiff = diff;
      bestExact = t;
    }
  }
  if (bestExact) return { trip: bestExact, approximate: false };

  // 2) Fallback within the airline's results: cheapest of the day for this
  //    airline+cabin+date. Better signal than nothing — it's at least the
  //    same airline's pricing, just not the exact same departure slot.
  const cheapest = trips.reduce((a, b) => (a.price < b.price ? a : b));
  return { trip: cheapest, approximate: true };
}

const fmtMins = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
const routePath = (r: Row) => [r.segments[0].da, ...r.segments.map((s) => s.aa)].join("-");
const operatedBy = (r: Row) => [...operatingCarriers(r)].join("/");
const flightNums = (r: Row) => r.segments.map((s) => s.flight_number).join("/");
const hhmm = (s: string) => {
  const m = s.match(/T?(\d{2}):(\d{2})/);
  if (!m) return s.slice(-5);
  const h24 = Number(m[1]);
  const ampm = h24 < 12 ? "a" : "p";
  const h12 = h24 % 12 || 12;
  return `${h12}:${m[2]}${ampm}`;
};
const times = (r: Row) => {
  const depT = hhmm(r.segments[0].dt);
  const arrT = hhmm(r.segments[r.segments.length - 1].at);
  const suffix = r.cross_days > 0 ? `+${r.cross_days}` : "";
  return `${depT}-${arrT}${suffix}`;
};
const transferBanks = (r: Row) =>
  !r.transfer?.length ? "(direct only)" : r.transfer.map((t) => t.code || t.bank).join(", ");
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const ANSI_BOLD_GREEN = "\x1b[1;32m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";
const isTTY = !!process.stdout.isTTY && !values.json;

// Each column knows its header, how to render a row's cell, alignment, the
// width it'd like, the minimum it'll shrink to, and a drop priority — lower
// priority columns are dropped first when the terminal is narrow.
type ColSpec = {
  key: string;
  header: string;
  align: "L" | "R";
  base: number;
  min: number;     // == base for non-shrinkable cols
  priority: number; // lower = dropped first; Infinity = never drop
  get: (r: Row) => string;
};

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatShortDate = (iso: string) => {
  const [, mm, dd] = iso.slice(0, 10).split("-");
  return `${SHORT_MONTHS[Number(mm) - 1]} ${Number(dd)}`;
};

const COL_SPECS: ColSpec[] = [
  ...(flexDays > 0
    ? [{ key: "date" as const, header: "DATE", align: "L" as const, base: 6, min: 6, priority: Infinity, get: (r: Row) => formatShortDate(r.segments[0].dt) }]
    : []),
  ...(returnDate
    ? [{ key: "leg" as const, header: "LEG", align: "L" as const, base: 4, min: 4, priority: Infinity, get: (r: Row) => r.leg === "outbound" ? "OUT" : "RET" }]
    : []),
  { key: "flies",    header: "FLIES",         align: "L", base: 8,  min: 8,  priority: Infinity, get: (r) => operatedBy(r) },
  { key: "flight",   header: "FLIGHT#",       align: "L", base: 14, min: 8,  priority: Infinity, get: (r) => flightNums(r) },
  { key: "times",    header: "TIMES",         align: "L", base: 14, min: 14, priority: 5,        get: (r) => times(r) },
  { key: "route",    header: "ROUTE",         align: "L", base: 14, min: 8,  priority: 1,        get: (r) => routePath(r) },
  { key: "dur",      header: "DUR",           align: "R", base: 6,  min: 6,  priority: 3,        get: (r) => fmtMins(r.duration) },
  { key: "cabin",    header: "CABIN",         align: "L", base: 15, min: 8,  priority: 2,        get: (r) => r.payment.cabin },
  { key: "miles",    header: "MILES",         align: "R", base: 7,  min: 7,  priority: Infinity, get: (r) => r.payment.miles.toLocaleString() },
  { key: "tax",      header: "+TAX",          align: "R", base: 7,  min: 7,  priority: 6,        get: (r) => `$${r.payment.tax.toFixed(2)}` },
  { key: "cash",     header: "CASH",          align: "R", base: 7,  min: 7,  priority: Infinity, get: (r) => { const m = matchCashForRow(r); return m ? `${m.approximate ? "~" : ""}$${m.trip.price}` : "—"; } },
  { key: "cpp",      header: "CPP",           align: "R", base: 6,  min: 6,  priority: Infinity, get: (r) => { const m = matchCashForRow(r); const c = cppOf(r); return c != null ? `${m?.approximate ? "~" : ""}${c.toFixed(2)}¢` : "—"; } },
  { key: "program",  header: "BOOK WITH",     align: "L", base: 26, min: 14, priority: 7,        get: (r) => r.programName },
  { key: "transfer", header: "TRANSFER FROM", align: "L", base: 32, min: 12, priority: 4,        get: (r) => transferBanks(r) },
];

const COL_GAP = 2;

function pickLayout(termWidth: number): ColSpec[] {
  const fit = (cols: ColSpec[], widths: Map<string, number>) =>
    cols.reduce((s, c) => s + (widths.get(c.key) ?? c.base), 0) + COL_GAP * Math.max(0, cols.length - 1);

  let cols = [...COL_SPECS];
  const widths = new Map(cols.map((c) => [c.key, c.base] as const));

  // Step 1: drop lowest-priority columns until what's left COULD fit at min widths.
  const dropOrder = [...cols]
    .filter((c) => Number.isFinite(c.priority))
    .sort((a, b) => a.priority - b.priority);
  for (const c of dropOrder) {
    const minTotal = cols.reduce((s, x) => s + x.min, 0) + COL_GAP * Math.max(0, cols.length - 1);
    if (minTotal <= termWidth) break;
    cols = cols.filter((x) => x.key !== c.key);
    widths.delete(c.key);
  }

  // Step 2: shrink shrinkable columns from base toward min until we fit.
  for (const c of cols) {
    if (fit(cols, widths) <= termWidth) break;
    const cur = widths.get(c.key)!;
    if (cur > c.min) {
      const overage = fit(cols, widths) - termWidth;
      widths.set(c.key, Math.max(c.min, cur - overage));
    }
  }

  return cols.map((c) => ({ ...c, base: widths.get(c.key)! }));
}

function renderCell(text: string, width: number, align: "L" | "R") {
  const t = truncate(text, width);
  return align === "L" ? t.padEnd(width) : t.padStart(width);
}

function buildHeader(layout: ColSpec[]) {
  return layout
    .map((c) => (c.align === "L" ? c.header.padEnd(c.base) : c.header.padStart(c.base)))
    .join(" ".repeat(COL_GAP));
}

function formatRowWithLayout(r: Row, layout: ColSpec[]): string {
  const line = layout.map((c) => renderCell(c.get(r), c.base, c.align)).join(" ".repeat(COL_GAP));
  const cpp = cppOf(r);
  if (isTTY && cpp != null && cpp >= CPP_HIGHLIGHT) return ANSI_BOLD_GREEN + line + ANSI_RESET;
  return line;
}

function currentLayout(): ColSpec[] {
  // Re-read each render so resizing the terminal mid-search reflows the table.
  const w = process.stdout.columns ?? 200;
  return pickLayout(Math.max(60, w));
}

// --- Live state shared between points polling and cash queries ---
const mergedPrograms = new Map<string, ProgramResult>();
let cashReady = false;
let pointsDone = false;
let lastRenderLines = 0;
const t0 = Date.now();

function buildRows(): Row[] {
  const all: Row[] = [...mergedPrograms.values()].flatMap((p) =>
    p.routes.map((r) => ({
      ...r,
      programName: p.program,
      programCode: p.code,
      leg: p.departure === dep ? ("outbound" as const) : ("return" as const),
    })),
  );
  const filtered = all.filter(passesFilters);
  filtered.sort(sortFn);
  return Number.isFinite(limit) ? filtered.slice(0, limit) : filtered;
}

function buildLegRows(leg: "outbound" | "return"): Row[] {
  return buildRows().filter((r) => r.leg === leg);
}

function toJsonRow(r: Row) {
  const m = matchCashForRow(r);
  const cpp = cppOf(r);
  return {
    ...r,
    cash_price: m?.trip.price ?? null,
    cash_approximate: m?.approximate ?? null,
    cpp: cpp,
  };
}

function statusLine(): string {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const totalRoutes = [...mergedPrograms.values()].reduce((s, p) => s + p.routes.length, 0);
  const cashStatus = cashReady ? "✓" : "…";
  const pointsStatus = pointsDone ? "✓" : "…";
  return `${ANSI_DIM}t=${elapsed}s   points ${pointsStatus} (${mergedPrograms.size} programs / ${totalRoutes} routes)   cash ${cashStatus}${ANSI_RESET}`;
}

function cashBaselineLine(): string {
  // Lowest cash seen for each cabin across the entire (date × airline) space.
  const minByCabin = new Map<Cabin, number>();
  for (const [key, trips] of cashByDateCabinAirline) {
    const cabin = key.split("|")[1] as Cabin;
    for (const t of trips) {
      const cur = minByCabin.get(cabin);
      if (cur === undefined || t.price < cur) minByCabin.set(cabin, t.price);
    }
  }
  const parts = [...minByCabin.entries()].map(
    ([c, price]) => `${c.toLowerCase().split(" ")[0]} from $${price}`,
  );
  return parts.length ? `${ANSI_DIM}cash baseline: ${parts.join(", ")}${ANSI_RESET}` : "";
}

function clearPreviousRender() {
  if (!isTTY || lastRenderLines === 0) return;
  // Move cursor up to the top of the rendered block, then clear from there down.
  process.stdout.write(`\x1b[${lastRenderLines}A\x1b[J`);
  lastRenderLines = 0;
}

function render() {
  if (!isTTY) return; // streaming render only in TTY mode
  clearPreviousRender();
  const rows = buildRows();
  const lines: string[] = [];
  lines.push(statusLine());
  const baseline = cashBaselineLine();
  if (baseline) lines.push(baseline);
  lines.push("");
  const layout = currentLayout();
  const header = buildHeader(layout);
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const r of rows) lines.push(formatRowWithLayout(r, layout));
  lines.push("");
  lines.push(
    `Showing ${rows.length} of ${[...mergedPrograms.values()].flatMap((p) => p.routes).length} returned (${mergedPrograms.size} programs).`,
  );
  const block = lines.join("\n") + "\n";
  process.stdout.write(block);
  lastRenderLines = lines.length;
}

// --- kick off ---

try {
  const token = await ensureFreshIdToken();
  process.env.POINTSYEAH_ID_TOKEN = token;
} catch (e) {
  const msg = (e as Error).message ?? String(e);
  if (!values.json) {
    if (msg.includes("auth-setup")) {
      console.log(
        "No saved Playwright session. Run `npm run auth-setup` once to sign in via Google.",
      );
    } else {
      console.log(msg);
    }
  }
}

const auth = getAuthContext();
if (!values.json) {
  if (auth) {
    console.log(`Auth: logged in (parseKeySection=${auth.parseKeySection}, expired=${auth.expired})`);
  } else {
    console.log("Auth: none — expect synthetic teaser data. Set POINTSYEAH_ID_TOKEN in .env.");
  }
  const [y, m, d] = date!.split("-");
  const rtSuffix = returnDate ? ` | return ${returnDate.split("-").slice(1).concat(returnDate.split("-")[0]).join("/")}` : "";
  console.log(
    `Searching ${dep} → ${arr} on ${m}/${d}/${y}${rtSuffix}${flexDays > 0 ? ` (+${flexDays} days)` : ""}${cabins ? ` (cabins: ${cabins.join(", ")})` : ""}…`,
  );
  console.log("");
}

// Lazy/debounced/batched cash quotes: only fire (date, cabin) tuples we
// actually see in points results, in a single batched Python subprocess.
const seenDateCabinAirline = new Set<string>();
const inflight = new Set<string>();
let flushing: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

interface BatchQuery {
  from: string;
  to: string;
  date: string;
  cabin: string;
  airlines: string[]; // single-element list; one query per (date, cabin, airline)
}

async function runBatch(queries: BatchQuery[]): Promise<Record<string, CashTrip[]>> {
  // Round-trip results via a temp file (PY_OUT env var). Avoids the stdout-
  // buffering races we hit when Python wrote large JSON to a piped stdout.
  const outPath = path.join(
    os.tmpdir(),
    `pointsyeah-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  return await new Promise((resolve) => {
    const child = spawn(VENV_PYTHON, [CASH_SCRIPT, "--batch"], {
      env: { ...process.env, PY_OUT: outPath },
      stdio: ["pipe", "ignore", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stdin.on("error", () => {
      /* swallow EPIPE */
    });
    child.on("error", () => resolve({}));
    child.on("close", async () => {
      try {
        const text = await fs.readFile(outPath, "utf8");
        const parsed = JSON.parse(text);
        if (!parsed.ok) {
          resolve({});
          return;
        }
        resolve((parsed.results ?? {}) as Record<string, CashTrip[]>);
      } catch (e) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 200);
        process.stderr.write(
          `[pointsyeah] batch read fail: ${(e as Error).message}; stderr=${stderr}\n`,
        );
        resolve({});
      } finally {
        await fs.unlink(outPath).catch(() => {});
      }
    });
    child.stdin.end(JSON.stringify(queries));
  });
}

async function doFlush(): Promise<void> {
  // Snapshot tuples we still need to fetch.
  const queries: BatchQuery[] = [];
  // Map our internal `${date}|${Cabin}|${airline}` key to the key the Python
  // script will echo back in `results` (`${date}|${Cabin}|${airline}`).
  // They're identical here, but we track them explicitly so the lookup is
  // explicit instead of implicit.
  const queryKeys: string[] = [];
  for (const key of seenDateCabinAirline) {
    if (cashByDateCabinAirline.has(key)) continue;
    if (inflight.has(key)) continue;
    const [from, to, d, cabinStr, airline] = key.split("|");
    const cabin = cabinStr as Cabin;

    // Disk cache first.
    if (useCache) {
      const file = cacheFileFor(from, to, d, cabin, airline);
      const cached = await readCashCache(file);
      if (cached) {
        cashByDateCabinAirline.set(key, cached);
        continue;
      }
    }

    inflight.add(key);
    queryKeys.push(key);
    queries.push({ from, to, date: d, cabin, airlines: [airline] });
  }

  if (queries.length === 0) {
    render();
    return;
  }
  const results = await runBatch(queries);
  for (const key of queryKeys) {
    const trips = results[key] ?? [];
    cashByDateCabinAirline.set(key, trips);
    inflight.delete(key);
    if (useCache) {
      const [from, to, d, cabinStr, airline] = key.split("|");
      const file = cacheFileFor(from, to, d, cabinStr as Cabin, airline);
      await writeCashCache(file, trips);
    }
  }
  render();
}

async function flushCashBatch(): Promise<void> {
  // Serialize: if a flush is in flight, wait for it before starting our own.
  while (flushing) {
    await flushing;
  }
  flushing = doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

function scheduleFlush() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void flushCashBatch();
  }, 300);
}

const programs = await search(
  { departure: dep, arrival: arr, departDate: date!, departDateTo, returnDate: returnDate ?? undefined, cabins: cabins as Cabin[] | undefined },
  {
    pollIntervalMs: 50,
    timeoutMs: 60_000,
    onUpdate: values.json
      ? undefined
      : (snap) => {
          let changed = false;
          let newTuple = false;
          for (const r of snap.data?.result ?? []) {
            const key = `${r.code}|${r.date}|${r.departure}|${r.arrival}`;
            const existing = mergedPrograms.get(key);
            if (!existing || r.routes.length > existing.routes.length) {
              mergedPrograms.set(key, r);
              changed = true;
              // Track every (date, cabin, operating-airline) tuple that
              // lands in points results AND passes the user's filters — no
              // point spending a cash query on a row we'd hide anyway.
              for (const route of r.routes) {
                const row: Row = { ...route, programName: r.program, programCode: r.code, leg: r.departure === dep ? "outbound" : "return" };
                if (!passesFilters(row)) continue;
                const rowDate = route.segments[0].dt.slice(0, 10);
                const cabin = route.payment.cabin as Cabin;
                const airline = route.segments[0].flight_number.match(/^[A-Z0-9]{2}/)?.[0];
                if (!airline) continue;
                const tupleKey = cashKey(r.departure, r.arrival, rowDate, cabin, airline);
                if (!seenDateCabinAirline.has(tupleKey)) {
                  seenDateCabinAirline.add(tupleKey);
                  newTuple = true;
                }
              }
            }
          }
          if (newTuple) scheduleFlush();
          if (changed) render();
        },
  },
);

pointsDone = true;
// Sync mergedPrograms to the lib's final view (in case any keys differ).
mergedPrograms.clear();
for (const p of programs) {
  mergedPrograms.set(`${p.code}|${p.date}|${p.departure}|${p.arrival}`, p);
  for (const route of p.routes) {
    const row: Row = { ...route, programName: p.program, programCode: p.code, leg: p.departure === dep ? "outbound" : "return" };
    if (!passesFilters(row)) continue;
    const rowDate = route.segments[0].dt.slice(0, 10);
    const cabin = route.payment.cabin as Cabin;
    const airline = route.segments[0].flight_number.match(/^[A-Z0-9]{2}/)?.[0];
    if (airline) seenDateCabinAirline.add(cashKey(p.departure, p.arrival, rowDate, cabin, airline));
  }
}
// Cancel any pending debounce, await any in-flight batch, then do a final
// flush to catch tuples that arrived in the last poll.
if (debounceTimer) {
  clearTimeout(debounceTimer);
  debounceTimer = null;
}
if (flushing) await flushing;
await flushCashBatch();
cashReady = true;
render();

if (values.json) {
  if (returnDate) {
    console.log(JSON.stringify({ outbound: buildLegRows("outbound").map(toJsonRow), return: buildLegRows("return").map(toJsonRow) }, null, 2));
  } else {
    console.log(JSON.stringify(buildRows().map(toJsonRow), null, 2));
  }
  process.exit(0);
}

// Final render — replaces the streaming view with the complete sorted table.
render();

// In non-TTY mode (piped output), no streaming happened; print one batch now.
if (!isTTY) {
  const layout = currentLayout();
  const header = buildHeader(layout);
  const totalRoutes = [...mergedPrograms.values()].flatMap((p) => p.routes).length;
  const allRows = buildRows();

  if (returnDate) {
    const outRows = allRows.filter((r) => r.leg === "outbound");
    const retRows = allRows.filter((r) => r.leg === "return");
    console.log(`OUTBOUND: ${dep} → ${arr}`);
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of outRows) console.log(formatRowWithLayout(r, layout));
    console.log(`\nRETURN: ${arr} → ${dep}`);
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of retRows) console.log(formatRowWithLayout(r, layout));
    console.log(`\nShowing ${outRows.length} outbound + ${retRows.length} return of ${totalRoutes} total (${mergedPrograms.size} programs, sorted by ${values.sort}).`);
  } else {
    console.log(header);
    console.log("-".repeat(header.length));
    for (const r of allRows) console.log(formatRowWithLayout(r, layout));
    console.log(`\nShowing ${allRows.length} of ${totalRoutes} returned (${mergedPrograms.size} programs, sorted by ${values.sort}).`);
  }
}
