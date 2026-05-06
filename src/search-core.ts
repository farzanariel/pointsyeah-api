/**
 * Shared award-search pipeline used by both the CLI (test-search.ts) and the
 * MCP server (mcp-server.ts).
 *
 * Responsibilities:
 *  - Auth (delegates to ensureFreshIdToken)
 *  - PointsYeah search (delegates to pointsyeah.ts)
 *  - Cash batch via the Python fast_flights subprocess
 *  - Per-row cash matching + cents-per-point calculation
 *  - Filters, sort, and limit
 *
 * Two entry points:
 *  - runSearch():    one-shot, no streaming. Used by the MCP server.
 *  - low-level:      cashCacheKey/runCashBatch/matchCash/computeCpp/passesFilters/sortRows
 *                    used by test-search.ts which keeps its own streaming loop
 *                    so the live TTY render still updates as PointsYeah results
 *                    trickle in.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  search,
  type Cabin,
  type ProgramResult,
  type Route,
  type RouteSegment,
} from "./pointsyeah.ts";
import { ensureFreshIdToken } from "./auth.ts";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const VENV_PYTHON = path.join(PROJECT_ROOT, ".venv/bin/python");
const CASH_SCRIPT = path.join(PROJECT_ROOT, "scripts/cash_quote.py");
const CACHE_DIR = path.join(os.homedir(), ".cache/pointsyeah");

export const CASH_CACHE_TTL_MS = 60 * 60 * 1000;

/** CPP thresholds used to derive `verdict` labels in the agent payload.
 *  Industry-standard CPP scoring (FrequentMiler / TPG averages):
 *   ≥2.0¢ great, ≥1.5¢ good, ≥1.0¢ meh, <1.0¢ poor. */
export const VERDICT_THRESHOLDS = {
  great: 2.0,
  good: 1.5,
  meh: 1.0,
} as const;

export type Verdict = "great" | "good" | "meh" | "poor" | "unknown";

export function verdictFromCpp(cpp: number | null): Verdict {
  if (cpp == null) return "unknown";
  if (cpp >= VERDICT_THRESHOLDS.great) return "great";
  if (cpp >= VERDICT_THRESHOLDS.good) return "good";
  if (cpp >= VERDICT_THRESHOLDS.meh) return "meh";
  return "poor";
}

export interface CashTrip {
  price: number;
  airlines: string[];
  stops: number;
  duration_minutes: number;
  departure: string; // ISO local
  arrival: string;
  from: string;
  to: string;
}

export interface CashMatch {
  trip: CashTrip;
  /** True when no exact-time match (±15 min) was found in the airline's
   *  same-day results and we fell back to its cheapest-of-day. The shown
   *  cash_usd is then a *lower bound* — actual is at least this. */
  approximate: boolean;
}

export interface SearchFilters {
  exactStops?: number;
  maxStops?: number;
  maxMiles?: number;
  maxTax?: number;
  banks?: string[];     // normalized lowercase, no separators
  programs?: string[];  // uppercase IATA-style codes
  airlines?: string[];  // uppercase IATA codes
  aircraft?: string[];  // case-insensitive substrings
}

export type SortKey = "miles" | "duration" | "tax" | "departure" | "cpp";

export interface EnrichedRow extends Route {
  programName: string;
  programCode: string;
  leg: "outbound" | "return";
  cashMatch?: CashMatch;
  cpp: number | null;
}

export interface SearchProgress {
  programs: ProgramResult[];
  cashByKey: Map<string, CashTrip[]>;
  pointsDone: boolean;
  cashDone: boolean;
  elapsedMs: number;
}

export interface RunSearchOptions {
  from: string;
  to: string;
  date: string;            // YYYY-MM-DD
  returnDate?: string;
  flexDays?: number;
  cabins?: Cabin[];
  filters?: SearchFilters;
  sort?: SortKey;
  limit?: number;
  noCache?: boolean;
  /** Skip cash batch entirely (faster; CPP fields will be null). */
  skipCash?: boolean;
}

export interface RunSearchResult {
  rows: EnrichedRow[];               // post-filter, post-sort, post-limit
  cashByKey: Map<string, CashTrip[]>;
  programs: ProgramResult[];
  totalRoutesReturned: number;       // before filter/limit
  durationMs: number;
}

// ─── Cache helpers ──────────────────────────────────────────────────────────

export function cashCacheKey(
  from: string,
  to: string,
  date: string,
  cabin: Cabin,
  airline: string,
): string {
  return `${from}|${to}|${date}|${cabin}|${airline}`;
}

export function cashCacheFile(
  from: string,
  to: string,
  date: string,
  cabin: Cabin,
  airline: string,
): string {
  const safeCabin = cabin.toLowerCase().replace(/\s+/g, "-");
  return path.join(
    CACHE_DIR,
    `cash-${from}-${to}-${date}-${safeCabin}-${airline}.json`,
  );
}

export async function readCashCache(file: string): Promise<CashTrip[] | null> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs > CASH_CACHE_TTL_MS) return null;
    return JSON.parse(await fs.readFile(file, "utf8")) as CashTrip[];
  } catch {
    return null;
  }
}

export async function writeCashCache(
  file: string,
  trips: CashTrip[],
): Promise<void> {
  // Don't poison the cache with empty results — they're almost always
  // transient (proxy hiccup, fast_flights flakiness). Better to let the next
  // search retry than serve [] for an hour.
  if (trips.length === 0) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(file, JSON.stringify(trips));
  } catch {
    /* cache write failure is non-fatal */
  }
}

// ─── Python cash batch ──────────────────────────────────────────────────────

export interface BatchQuery {
  from: string;
  to: string;
  date: string;
  cabin: Cabin;        // Capitalized form. Python normalizes internally.
  airlines: string[];  // single-element list per query
}

interface PythonBatchResponse {
  ok: boolean;
  results?: Record<string, CashTrip[]>;
  error?: string;
}

/**
 * Spawn the Python fast_flights script in batch mode.
 *
 * Results are routed through a temp file (PY_OUT env var) instead of stdout
 * because Node drops bytes when the child writes large JSON to a piped
 * stdout that's been set to "ignore". Piping stderr lets us surface real
 * errors when the JSON parse fails.
 */
export function runCashBatch(
  queries: BatchQuery[],
): Promise<Record<string, CashTrip[]>> {
  if (queries.length === 0) return Promise.resolve({});
  const outPath = path.join(
    os.tmpdir(),
    `pointsyeah-batch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  return new Promise((resolve) => {
    const child = spawn(VENV_PYTHON, [CASH_SCRIPT, "--batch"], {
      env: { ...process.env, PY_OUT: outPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    const stdoutChunks: Buffer[] = [];
    child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stdin.on("error", () => {
      /* swallow EPIPE; close handler will surface details */
    });
    child.on("error", (e: Error) => {
      console.error(`[search-core] cash spawn failed: ${e.message}`);
      resolve({});
    });
    child.on("close", async (code: number | null) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      try {
        const text = await fs.readFile(outPath, "utf8");
        const parsed = JSON.parse(text) as PythonBatchResponse;
        if (!parsed.ok) {
          console.error(
            `[search-core] cash batch returned not-ok (exit=${code}): ${parsed.error ?? "?"}`,
          );
          resolve({});
          return;
        }
        resolve(parsed.results ?? {});
      } catch (e) {
        console.error(
          `[search-core] cash batch read fail (exit=${code}): ${(e as Error).message}; ` +
            `stderr=${stderr.slice(-500)}`,
        );
        resolve({});
      } finally {
        await fs.unlink(outPath).catch(() => {});
      }
    });
    child.stdin.end(JSON.stringify(queries));
  });
}

// ─── Row-level helpers ──────────────────────────────────────────────────────

export const stopsOf = (r: Route): number => r.segments.length - 1;

export function operatingCarriers(r: Route): Set<string> {
  return new Set(
    r.segments.map((s) => s.flight_number.match(/^[A-Z0-9]{2}/)?.[0] ?? "??"),
  );
}

export function firstSegmentAirline(r: Route): string | undefined {
  return r.segments[0]?.flight_number.match(/^[A-Z0-9]{2}/)?.[0];
}

export function normalizeBank(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_-]/g, "");
}

/**
 * Match a route to a cash trip from the cash bucket for its (from,to,date,cabin,airline).
 *
 * 1. Exact: same departure airport, ±15 min — `approximate: false`.
 * 2. Fallback: airline's cheapest-of-day for that bucket — `approximate: true`.
 *    The shown price is then a lower bound (actual cash is at least this).
 */
export function matchCash(
  r: Route,
  cabin: Cabin,
  trips: CashTrip[],
): CashMatch | undefined {
  if (!trips.length) return undefined;
  const seg0 = r.segments[0];
  if (!seg0) return undefined;
  const rowDep = new Date(seg0.dt).getTime();

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

  const cheapest = trips.reduce((a, b) => (a.price < b.price ? a : b));
  return { trip: cheapest, approximate: true };
}

export function computeCpp(
  miles: number,
  taxUsd: number,
  cashUsd: number,
): number | null {
  if (miles <= 0) return null;
  return ((cashUsd - taxUsd) / miles) * 100;
}

// ─── Filtering ──────────────────────────────────────────────────────────────

export function passesFilters(
  r: EnrichedRow,
  filters: SearchFilters | undefined,
): boolean {
  if (!filters) return true;
  const stops = stopsOf(r);
  if (filters.exactStops !== undefined && stops !== filters.exactStops) return false;
  if (filters.maxStops !== undefined && stops > filters.maxStops) return false;
  if (filters.maxMiles !== undefined && r.payment.miles > filters.maxMiles) return false;
  if (filters.maxTax !== undefined && r.payment.tax > filters.maxTax) return false;
  if (filters.programs?.length) {
    const set = new Set(filters.programs.map((p) => p.toUpperCase()));
    if (!set.has(r.programCode.toUpperCase())) return false;
  }
  if (filters.airlines?.length) {
    const set = new Set(filters.airlines.map((a) => a.toUpperCase()));
    const carriers = operatingCarriers(r);
    if (![...carriers].every((c) => set.has(c))) return false;
  }
  if (filters.aircraft?.length) {
    const needles = filters.aircraft.map((a) => a.trim().toLowerCase()).filter(Boolean);
    const allMatch = r.segments.every((s) => {
      const a = (s.aircraft ?? "").toLowerCase();
      return needles.some((needle) => a.includes(needle));
    });
    if (!allMatch) return false;
  }
  if (filters.banks?.length) {
    const wanted = new Set(filters.banks.map(normalizeBank));
    const banks = (r.transfer ?? []).map((t) => normalizeBank(t.code || t.bank));
    if (!banks.some((b) => wanted.has(b))) return false;
  }
  return true;
}

// ─── Sorting ────────────────────────────────────────────────────────────────

const tiebreakStops = (a: EnrichedRow, b: EnrichedRow) =>
  stopsOf(a) - stopsOf(b) ||
  a.segments[0].dt.localeCompare(b.segments[0].dt);

export const SORTERS: Record<SortKey, (a: EnrichedRow, b: EnrichedRow) => number> = {
  miles: (a, b) => a.payment.miles - b.payment.miles || tiebreakStops(a, b),
  duration: (a, b) => a.duration - b.duration || tiebreakStops(a, b),
  tax: (a, b) => a.payment.tax - b.payment.tax || tiebreakStops(a, b),
  departure: (a, b) => a.segments[0].dt.localeCompare(b.segments[0].dt) || tiebreakStops(a, b),
  cpp: (a, b) => {
    if (a.cpp == null && b.cpp == null) return tiebreakStops(a, b);
    if (a.cpp == null) return 1;
    if (b.cpp == null) return -1;
    return b.cpp - a.cpp || tiebreakStops(a, b);
  },
};

export function sortRows(rows: EnrichedRow[], sort: SortKey): EnrichedRow[] {
  return [...rows].sort(SORTERS[sort]);
}

// ─── Date helpers ───────────────────────────────────────────────────────────

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── High-level: runSearch ──────────────────────────────────────────────────

/**
 * One-shot pipeline used by the MCP server.
 *
 * Cash queries are interleaved with the PointsYeah polling: as program
 * results land, we extract (from,to,date,cabin,airline) tuples and queue
 * cash batches in parallel with debouncing. By the time PointsYeah's poll
 * loop finishes, most cash queries are already done. This typically halves
 * the wall-clock time for cold-cache calls.
 */
export async function runSearch(opts: RunSearchOptions): Promise<RunSearchResult> {
  const startedAt = Date.now();

  // 1. Auth
  const token = await ensureFreshIdToken();
  process.env.POINTSYEAH_ID_TOKEN = token;

  const flexDays = Math.max(0, Math.min(60, opts.flexDays ?? 0));
  const departDateTo = flexDays > 0 ? addDaysISO(opts.date, flexDays) : undefined;

  // Cash pipeline state.
  const cashByKey = new Map<string, CashTrip[]>();
  const useCache = !opts.noCache;
  const seen = new Set<string>();
  const inflight = new Set<string>();
  let flushPromise: Promise<void> | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function tupleKeyForRoute(route: Route): string | undefined {
    const airline = firstSegmentAirline(route);
    if (!airline) return undefined;
    const seg0 = route.segments[0];
    const segLast = route.segments[route.segments.length - 1];
    if (!seg0 || !segLast) return undefined;
    const rowDate = seg0.dt.slice(0, 10);
    const cabin = route.payment.cabin as Cabin;
    return cashCacheKey(seg0.da, segLast.aa, rowDate, cabin, airline);
  }

  async function doFlush(): Promise<void> {
    const queries: BatchQuery[] = [];
    const queryKeys: string[] = [];
    for (const key of seen) {
      if (cashByKey.has(key) || inflight.has(key)) continue;
      const [from, to, d, cabinStr, airline] = key.split("|");
      const cabin = cabinStr as Cabin;
      if (useCache) {
        const file = cashCacheFile(from, to, d, cabin, airline);
        const cached = await readCashCache(file);
        if (cached && cached.length > 0) {
          cashByKey.set(key, cached);
          continue;
        }
      }
      inflight.add(key);
      queryKeys.push(key);
      queries.push({ from, to, date: d, cabin, airlines: [airline] });
    }
    if (queries.length === 0) return;
    const results = await runCashBatch(queries);
    for (const key of queryKeys) {
      const trips = results[key] ?? [];
      cashByKey.set(key, trips);
      inflight.delete(key);
      if (useCache && trips.length > 0) {
        const [from, to, d, cabinStr, airline] = key.split("|");
        const file = cashCacheFile(from, to, d, cabinStr as Cabin, airline);
        await writeCashCache(file, trips);
      }
    }
  }

  async function flush(): Promise<void> {
    while (flushPromise) await flushPromise;
    flushPromise = doFlush().finally(() => {
      flushPromise = null;
    });
    return flushPromise;
  }

  function scheduleFlush(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flush();
    }, 300);
  }

  function enqueueRoute(p: ProgramResult, route: Route): boolean {
    const enriched: EnrichedRow = {
      ...route,
      programName: p.program,
      programCode: p.code,
      leg: p.departure === opts.from ? "outbound" : "return",
      cpp: null,
    };
    if (!passesFilters(enriched, opts.filters)) return false;
    const key = tupleKeyForRoute(route);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }

  // 2. PointsYeah search with interleaved cash.
  const programs = await search(
    {
      departure: opts.from,
      arrival: opts.to,
      departDate: opts.date,
      departDateTo,
      returnDate: opts.returnDate,
      cabins: opts.cabins,
    },
    {
      pollIntervalMs: 50,
      timeoutMs: 60_000,
      onUpdate: opts.skipCash
        ? undefined
        : (snap) => {
            let newTuple = false;
            for (const p of snap.data?.result ?? []) {
              for (const route of p.routes) {
                if (enqueueRoute(p, route)) newTuple = true;
              }
            }
            if (newTuple) scheduleFlush();
          },
    },
  );

  // 3. Reconcile final view (catch any tuples missed during streaming).
  if (!opts.skipCash) {
    for (const p of programs) {
      for (const route of p.routes) {
        enqueueRoute(p, route);
      }
    }

    // Wait for any in-flight, then do one final flush.
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (flushPromise) await flushPromise;
    await flush();
  }

  // 4. Build EnrichedRow list (cash not yet attached).
  const rawRows: EnrichedRow[] = [];
  for (const p of programs) {
    for (const route of p.routes) {
      rawRows.push({
        ...route,
        programName: p.program,
        programCode: p.code,
        leg: p.departure === opts.from ? "outbound" : "return",
        cpp: null,
      });
    }
  }
  const totalRoutesReturned = rawRows.length;

  // 5. Filter, attach cash + CPP, sort, limit.
  const passing = rawRows.filter((r) => passesFilters(r, opts.filters));
  for (const r of passing) {
    const key = tupleKeyForRoute(r);
    if (!key) continue;
    const trips = cashByKey.get(key);
    if (!trips?.length) continue;
    const m = matchCash(r, r.payment.cabin as Cabin, trips);
    if (!m) continue;
    r.cashMatch = m;
    r.cpp = computeCpp(r.payment.miles, r.payment.tax, m.trip.price);
  }

  const sorted = sortRows(passing, opts.sort ?? "miles");
  const limited =
    opts.limit && opts.limit > 0 && Number.isFinite(opts.limit)
      ? sorted.slice(0, opts.limit)
      : sorted;

  return {
    rows: limited,
    cashByKey,
    programs,
    totalRoutesReturned,
    durationMs: Date.now() - startedAt,
  };
}

// ─── Re-exports for convenience ─────────────────────────────────────────────

export type { Cabin, Route, RouteSegment, ProgramResult };
