import { parseArgs } from "node:util";
import {
  search,
  getAuthContext,
  type Cabin,
  type ProgramResult,
} from "./pointsyeah.ts";
import { ensureFreshIdToken } from "./auth.ts";
import {
  cashCacheFile,
  cashCacheKey,
  computeCpp,
  firstSegmentAirline,
  matchCash,
  operatingCarriers,
  passesFilters as passesFiltersCore,
  readCashCache,
  runCashBatch,
  sortRows,
  writeCashCache,
  type BatchQuery,
  type CashTrip,
  type EnrichedRow,
  type SearchFilters,
  type SortKey,
} from "./search-core.ts";

const CPP_HIGHLIGHT = 1.5;

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

const flexDays = values.flex !== undefined ? Math.max(0, Math.min(60, Number(values.flex))) : 0;
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const departDateTo = flexDays > 0 ? addDays(date!, flexDays) : undefined;

const exactStops: number | undefined = values.nonstop
  ? 0
  : values["one-stop"]
    ? 1
    : undefined;
const maxStops =
  values["max-stops"] !== undefined ? Number(values["max-stops"]) : undefined;
const maxMiles = values["max-miles"] !== undefined ? Number(values["max-miles"]) : undefined;
const maxTax = values["max-tax"] !== undefined ? Number(values["max-tax"]) : undefined;

const filters: SearchFilters = {
  exactStops,
  maxStops,
  maxMiles,
  maxTax,
  banks: values.bank?.length ? values.bank : undefined,
  programs: values.program?.length ? values.program : undefined,
  airlines: values.airline?.length ? values.airline : undefined,
  aircraft: values.aircraft?.length ? values.aircraft : undefined,
};

const passesFilters = (r: EnrichedRow) => passesFiltersCore(r, filters);

if (!values.sort || !["miles", "duration", "tax", "departure", "cpp"].includes(values.sort)) {
  console.error(`Unknown --sort "${values.sort}". Try: miles | duration | tax | departure | cpp`);
  process.exit(1);
}
const sortKey = values.sort as SortKey;

const limit =
  values.limit === undefined || values.limit.toLowerCase() === "all"
    ? Infinity
    : Math.max(1, Number(values.limit));

const useCache = !values["no-cache"];

// Live state shared between points polling and cash queries.
const cashByDateCabinAirline = new Map<string, CashTrip[]>();

function rowCashKey(r: EnrichedRow): string | undefined {
  const airline = firstSegmentAirline(r);
  if (!airline) return undefined;
  const seg0 = r.segments[0];
  const segLast = r.segments[r.segments.length - 1];
  const rowDate = seg0.dt.slice(0, 10);
  const cabin = r.payment.cabin as Cabin;
  return cashCacheKey(seg0.da, segLast.aa, rowDate, cabin, airline);
}

function matchCashForRow(r: EnrichedRow) {
  const key = rowCashKey(r);
  if (!key) return undefined;
  const trips = cashByDateCabinAirline.get(key);
  if (!trips?.length) return undefined;
  return matchCash(r, r.payment.cabin as Cabin, trips);
}

function cppOf(r: EnrichedRow): number | null {
  const m = matchCashForRow(r);
  if (!m) return null;
  return computeCpp(r.payment.miles, r.payment.tax, m.trip.price);
}

const fmtMins = (m: number) => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
const routePath = (r: EnrichedRow) => [r.segments[0].da, ...r.segments.map((s) => s.aa)].join("-");
const operatedBy = (r: EnrichedRow) => [...operatingCarriers(r)].join("/");
const flightNums = (r: EnrichedRow) => r.segments.map((s) => s.flight_number).join("/");
const hhmm = (s: string) => {
  const m = s.match(/T?(\d{2}):(\d{2})/);
  if (!m) return s.slice(-5);
  const h24 = Number(m[1]);
  const ampm = h24 < 12 ? "a" : "p";
  const h12 = h24 % 12 || 12;
  return `${h12}:${m[2]}${ampm}`;
};
const times = (r: EnrichedRow) => {
  const depT = hhmm(r.segments[0].dt);
  const arrT = hhmm(r.segments[r.segments.length - 1].at);
  const suffix = r.cross_days > 0 ? `+${r.cross_days}` : "";
  return `${depT}-${arrT}${suffix}`;
};
const transferBanks = (r: EnrichedRow) =>
  !r.transfer?.length ? "(direct only)" : r.transfer.map((t) => t.code || t.bank).join(", ");
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

const ANSI_BOLD_GREEN = "\x1b[1;32m";
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";
const isTTY = !!process.stdout.isTTY && !values.json;

type ColSpec = {
  key: string;
  header: string;
  align: "L" | "R";
  base: number;
  min: number;
  priority: number;
  get: (r: EnrichedRow) => string;
};

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const formatShortDate = (iso: string) => {
  const [, mm, dd] = iso.slice(0, 10).split("-");
  return `${SHORT_MONTHS[Number(mm) - 1]} ${Number(dd)}`;
};

const COL_SPECS: ColSpec[] = [
  ...(flexDays > 0
    ? [{ key: "date" as const, header: "DATE", align: "L" as const, base: 6, min: 6, priority: Infinity, get: (r: EnrichedRow) => formatShortDate(r.segments[0].dt) }]
    : []),
  ...(returnDate
    ? [{ key: "leg" as const, header: "LEG", align: "L" as const, base: 4, min: 4, priority: Infinity, get: (r: EnrichedRow) => r.leg === "outbound" ? "OUT" : "RET" }]
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

  const dropOrder = [...cols]
    .filter((c) => Number.isFinite(c.priority))
    .sort((a, b) => a.priority - b.priority);
  for (const c of dropOrder) {
    const minTotal = cols.reduce((s, x) => s + x.min, 0) + COL_GAP * Math.max(0, cols.length - 1);
    if (minTotal <= termWidth) break;
    cols = cols.filter((x) => x.key !== c.key);
    widths.delete(c.key);
  }

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

function formatRowWithLayout(r: EnrichedRow, layout: ColSpec[]): string {
  const line = layout.map((c) => renderCell(c.get(r), c.base, c.align)).join(" ".repeat(COL_GAP));
  const cpp = cppOf(r);
  if (isTTY && cpp != null && cpp >= CPP_HIGHLIGHT) return ANSI_BOLD_GREEN + line + ANSI_RESET;
  return line;
}

function currentLayout(): ColSpec[] {
  const w = process.stdout.columns ?? 200;
  return pickLayout(Math.max(60, w));
}

const mergedPrograms = new Map<string, ProgramResult>();
let cashReady = false;
let pointsDone = false;
let lastRenderLines = 0;
const t0 = Date.now();

function buildRows(): EnrichedRow[] {
  const all: EnrichedRow[] = [...mergedPrograms.values()].flatMap((p) =>
    p.routes.map((r) => ({
      ...r,
      programName: p.program,
      programCode: p.code,
      leg: p.departure === dep ? ("outbound" as const) : ("return" as const),
      cpp: null as number | null,
    })),
  );
  // Pre-populate cpp so sort='cpp' works on live data.
  for (const r of all) r.cpp = cppOf(r);
  const filtered = all.filter(passesFilters);
  const sorted = sortRows(filtered, sortKey);
  return Number.isFinite(limit) ? sorted.slice(0, limit) : sorted;
}

function buildLegRows(leg: "outbound" | "return"): EnrichedRow[] {
  return buildRows().filter((r) => r.leg === leg);
}

function toJsonRow(r: EnrichedRow) {
  const m = matchCashForRow(r);
  const cpp = cppOf(r);
  return {
    ...r,
    cash_price: m?.trip.price ?? null,
    cash_approximate: m?.approximate ?? null,
    cpp,
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
  const minByCabin = new Map<Cabin, number>();
  for (const [key, trips] of cashByDateCabinAirline) {
    const cabin = key.split("|")[3] as Cabin;
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
  process.stdout.write(`\x1b[${lastRenderLines}A\x1b[J`);
  lastRenderLines = 0;
}

function render() {
  if (!isTTY) return;
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

// ─── kick off ──────────────────────────────────────────────────────────────

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

// Lazy/debounced/batched cash quotes: only fire (date, cabin, airline) tuples
// we actually see in points results, in a single batched Python subprocess.
const seenDateCabinAirline = new Set<string>();
const inflight = new Set<string>();
let flushing: Promise<void> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

async function doFlush(): Promise<void> {
  const queries: BatchQuery[] = [];
  const queryKeys: string[] = [];
  for (const key of seenDateCabinAirline) {
    if (cashByDateCabinAirline.has(key)) continue;
    if (inflight.has(key)) continue;
    const [from, to, d, cabinStr, airline] = key.split("|");
    const cabin = cabinStr as Cabin;

    if (useCache) {
      const file = cashCacheFile(from, to, d, cabin, airline);
      const cached = await readCashCache(file);
      if (cached && cached.length > 0) {
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
  const results = await runCashBatch(queries);
  for (const key of queryKeys) {
    const trips = results[key] ?? [];
    cashByDateCabinAirline.set(key, trips);
    inflight.delete(key);
    if (useCache && trips.length > 0) {
      const [from, to, d, cabinStr, airline] = key.split("|");
      const file = cashCacheFile(from, to, d, cabinStr as Cabin, airline);
      await writeCashCache(file, trips);
    }
  }
  render();
}

async function flushCashBatch(): Promise<void> {
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
              for (const route of r.routes) {
                const row: EnrichedRow = {
                  ...route,
                  programName: r.program,
                  programCode: r.code,
                  leg: r.departure === dep ? "outbound" : "return",
                  cpp: null,
                };
                if (!passesFilters(row)) continue;
                const tupleKey = rowCashKey(row);
                if (tupleKey && !seenDateCabinAirline.has(tupleKey)) {
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
mergedPrograms.clear();
for (const p of programs) {
  mergedPrograms.set(`${p.code}|${p.date}|${p.departure}|${p.arrival}`, p);
  for (const route of p.routes) {
    const row: EnrichedRow = {
      ...route,
      programName: p.program,
      programCode: p.code,
      leg: p.departure === dep ? "outbound" : "return",
      cpp: null,
    };
    if (!passesFilters(row)) continue;
    const tupleKey = rowCashKey(row);
    if (tupleKey) seenDateCabinAirline.add(tupleKey);
  }
}
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

render();

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

