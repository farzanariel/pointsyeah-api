import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { search, type Cabin, type Route } from "./pointsyeah.ts";
import { ensureFreshIdToken } from "./auth.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const STATE_DIR = path.join(PROJECT_ROOT, "data");

try {
  process.loadEnvFile(".env");
} catch {
  /* no .env — fine */
}

const HELP = `\
Usage: npm run watch -- <DEP> <ARR> <MM/DD/YYYY> [options]
   (also accepts YYYY-MM-DD)

Polls the search on an interval and pings Discord when the miles
price for a specific flight drops below the lowest seen so far.

Requires DISCORD_WEBHOOK_URL in .env (Server → Integrations → Webhooks).

Pin to a specific flight with --flight (repeatable, in segment order):
  --flight UA123                 (nonstop)
  --flight UA123 --flight UA456  (connection)
Without --flight it tracks the cheapest itinerary matching the filters,
which can silently switch flights when something else gets cheaper.

Options:
  -f, --flight <num>    flight number, e.g. UA123. repeatable for connections
  -c, --cabin <c>       economy | premium | business | first   (filter)
      --interval <min>  poll every N minutes  (default: 60)
      --max-stops <n>   0, 1, 2…
  -a, --airline <code>  operating airline (UA, AA…). repeatable
  -p, --program <code>  award program. repeatable
      --target <miles>  also ping if price ≤ this number, even on no drop
      --once            run a single check then exit (for cron)
  -h, --help            show this
`;

let parsed;
try {
  parsed = parseArgs({
    options: {
      cabin: { type: "string", short: "c" },
      flight: { type: "string", multiple: true, short: "f" },
      interval: { type: "string" },
      "max-stops": { type: "string" },
      airline: { type: "string", multiple: true, short: "a" },
      program: { type: "string", multiple: true, short: "p" },
      target: { type: "string" },
      once: { type: "boolean" },
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
  console.error(`Need <DEP> <ARR> <MM/DD/YYYY>.\n\n${HELP}`);
  process.exit(1);
}

const CABIN_ALIASES: Record<string, Cabin> = {
  economy: "Economy", e: "Economy", y: "Economy",
  premium: "Premium Economy", "premium-economy": "Premium Economy", pe: "Premium Economy", w: "Premium Economy",
  business: "Business", biz: "Business", j: "Business", c: "Business",
  first: "First", f: "First",
};
const cabin: Cabin | undefined = values.cabin
  ? CABIN_ALIASES[values.cabin.trim().toLowerCase()]
  : undefined;
if (values.cabin && !cabin) {
  console.error(`Unknown cabin "${values.cabin}".`);
  process.exit(1);
}

const normalizeFlight = (s: string) => s.trim().toUpperCase().replace(/\s+/g, "");
const flightNums: string[] | null = values.flight?.length
  ? values.flight.map(normalizeFlight)
  : null;
if (flightNums && !flightNums.every((f) => /^[A-Z0-9]{2}\d{1,4}$/.test(f))) {
  console.error(`--flight expects values like "UA123". Got: ${flightNums.join(", ")}`);
  process.exit(1);
}

const intervalMin = values.interval ? Math.max(5, Number(values.interval)) : 60;
const maxStops = values["max-stops"] !== undefined ? Number(values["max-stops"]) : undefined;
const target = values.target !== undefined ? Number(values.target) : undefined;
const airlineFilter = values.airline?.length
  ? new Set(values.airline.map((s) => s.toUpperCase()))
  : null;
const programFilter = values.program?.length
  ? new Set(values.program.map((s) => s.toUpperCase()))
  : null;

const webhook = process.env.DISCORD_WEBHOOK_URL;
if (!webhook) {
  console.error("DISCORD_WEBHOOK_URL is not set in .env");
  process.exit(1);
}

const slug = [
  dep, arr, date,
  cabin ? cabin.toLowerCase().replace(/\s+/g, "-") : "any",
  flightNums ? flightNums.join("-") : "anyflight",
].join("_");
const stateFile = path.join(STATE_DIR, `watch-${slug}.json`);

interface WatchState {
  lowestMiles: number;
  lastNotifiedMiles: number | null;
  lastCheckedAt: string;
  best?: BestSnapshot;
}

interface BestSnapshot {
  miles: number;
  tax: number;
  programName: string;
  programCode: string;
  airline: string;
  flightNumbers: string;
  cabin: string;
  depTime: string;
  arrTime: string;
  stops: number;
}

async function readState(): Promise<WatchState | null> {
  try {
    return JSON.parse(await fs.readFile(stateFile, "utf8")) as WatchState;
  } catch {
    return null;
  }
}

async function writeState(s: WatchState): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(s, null, 2));
}

interface Row extends Route {
  programName: string;
  programCode: string;
}

const opCarriers = (r: Row): string[] =>
  [...new Set(r.segments.map((s) => s.flight_number.match(/^[A-Z0-9]{2}/)?.[0] ?? "??"))];

function passes(r: Row): boolean {
  if (cabin && r.payment.cabin !== cabin) return false;
  if (maxStops !== undefined && r.segments.length - 1 > maxStops) return false;
  if (programFilter && !programFilter.has(r.programCode.toUpperCase())) return false;
  if (airlineFilter) {
    const carriers = opCarriers(r);
    if (!carriers.every((c) => airlineFilter.has(c))) return false;
  }
  if (flightNums) {
    if (r.segments.length !== flightNums.length) return false;
    for (let i = 0; i < flightNums.length; i++) {
      if (normalizeFlight(r.segments[i].flight_number) !== flightNums[i]) return false;
    }
  }
  return true;
}

function snapshot(r: Row): BestSnapshot {
  const seg0 = r.segments[0];
  const segN = r.segments[r.segments.length - 1];
  return {
    miles: r.payment.miles,
    tax: r.payment.tax,
    programName: r.programName,
    programCode: r.programCode,
    airline: opCarriers(r).join("/"),
    flightNumbers: r.segments.map((s) => s.flight_number).join("/"),
    cabin: r.payment.cabin,
    depTime: seg0.dt,
    arrTime: segN.at,
    stops: r.segments.length - 1,
  };
}

async function postDiscord(content: string, best: BestSnapshot, oldMiles: number | null): Promise<void> {
  const fmt = (n: number) => n.toLocaleString();
  const delta = oldMiles != null ? oldMiles - best.miles : null;
  const fields = [
    { name: "Route", value: `${dep} → ${arr}`, inline: true },
    { name: "Date", value: date, inline: true },
    { name: "Cabin", value: best.cabin, inline: true },
    {
      name: "Miles",
      value: oldMiles != null
        ? `**${fmt(best.miles)}** (was ${fmt(oldMiles)}, −${fmt(delta!)})`
        : `**${fmt(best.miles)}**`,
      inline: true,
    },
    { name: "Taxes", value: `$${best.tax.toFixed(2)}`, inline: true },
    { name: "Stops", value: String(best.stops), inline: true },
    { name: "Airline", value: best.airline, inline: true },
    { name: "Flight #", value: best.flightNumbers, inline: true },
    { name: "Book with", value: best.programName, inline: false },
  ];
  const body = {
    content,
    embeds: [{
      title: `${dep} → ${arr} on ${date}`,
      color: 0x2ecc71,
      fields,
      timestamp: new Date().toISOString(),
    }],
  };
  const res = await fetch(webhook!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
}

async function checkOnce(): Promise<void> {
  try {
    const token = await ensureFreshIdToken();
    process.env.POINTSYEAH_ID_TOKEN = token;
  } catch (e) {
    console.error(`Auth failed: ${(e as Error).message}`);
    return;
  }

  const programs = await search(
    {
      departure: dep,
      arrival: arr,
      departDate: date!,
      cabins: cabin ? [cabin] : undefined,
    },
    { pollIntervalMs: 200, timeoutMs: 60_000 },
  );

  const rows: Row[] = programs.flatMap((p) =>
    p.routes.map((r) => ({ ...r, programName: p.program, programCode: p.code })),
  );
  const matching = rows.filter(passes);
  if (matching.length === 0) {
    console.log(`[${new Date().toISOString()}] no matching routes`);
    return;
  }
  matching.sort((a, b) => a.payment.miles - b.payment.miles);
  const best = matching[0];
  const newSnap = snapshot(best);
  const state = await readState();
  const ts = new Date().toISOString();

  if (!state) {
    await writeState({
      lowestMiles: newSnap.miles,
      lastNotifiedMiles: null,
      lastCheckedAt: ts,
      best: newSnap,
    });
    console.log(`[${ts}] first check: ${newSnap.miles.toLocaleString()} miles (baseline saved, no notification)`);
    return;
  }

  const dropped = newSnap.miles < state.lowestMiles;
  const hitTarget =
    target !== undefined &&
    newSnap.miles <= target &&
    (state.lastNotifiedMiles === null || state.lastNotifiedMiles > newSnap.miles);

  if (dropped) {
    await postDiscord(
      `🔻 Price drop on ${dep} → ${arr} ${date}`,
      newSnap,
      state.lowestMiles,
    );
    await writeState({
      lowestMiles: newSnap.miles,
      lastNotifiedMiles: newSnap.miles,
      lastCheckedAt: ts,
      best: newSnap,
    });
    console.log(
      `[${ts}] DROP: ${state.lowestMiles.toLocaleString()} → ${newSnap.miles.toLocaleString()} miles. Notified.`,
    );
  } else if (hitTarget) {
    await postDiscord(
      `🎯 Target hit on ${dep} → ${arr} ${date} (≤ ${target!.toLocaleString()})`,
      newSnap,
      null,
    );
    await writeState({ ...state, lastNotifiedMiles: newSnap.miles, lastCheckedAt: ts, best: newSnap });
    console.log(`[${ts}] target hit: ${newSnap.miles.toLocaleString()} ≤ ${target}. Notified.`);
  } else {
    await writeState({ ...state, lastCheckedAt: ts });
    console.log(
      `[${ts}] no drop: ${newSnap.miles.toLocaleString()} miles (low: ${state.lowestMiles.toLocaleString()})`,
    );
  }
}

console.log(
  `Watching ${dep} → ${arr} on ${date}` +
    (cabin ? ` (${cabin})` : "") +
    (values.once ? " — single check" : ` every ${intervalMin}m`),
);
console.log(`State: ${stateFile}`);

if (values.once) {
  await checkOnce();
  process.exit(0);
}

while (true) {
  try {
    await checkOnce();
  } catch (e) {
    console.error(`Check failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, intervalMin * 60 * 1000));
}
