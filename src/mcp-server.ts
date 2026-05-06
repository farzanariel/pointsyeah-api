/**
 * PointsYeah MCP server.
 *
 * Streamable HTTP transport, bearer-token gated. Exposes a single tool
 * (search_flights) designed for AI-agent consumption: slim per-row payload,
 * a top-level summary the agent can latch onto without traversing rows,
 * precomputed CPP verdicts so the agent doesn't have to do the math, and a
 * declared outputSchema so the agent parses with confidence.
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  runSearch,
  verdictFromCpp,
  type Cabin,
  type EnrichedRow,
  type RunSearchOptions,
  type RunSearchResult,
  type SearchFilters,
  type SortKey,
  type Verdict,
} from "./search-core.ts";

const PORT = Number(process.env.PORT ?? 9180);
const HOST = process.env.HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const DEBUG = !!process.env.MCP_DEBUG;

if (!AUTH_TOKEN) {
  console.error("FATAL: MCP_AUTH_TOKEN env var is required");
  process.exit(1);
}

// ─── Input schema (agent-facing) ────────────────────────────────────────────

const cabinShortToFull: Record<string, Cabin> = {
  economy: "Economy",
  premium: "Premium Economy",
  "premium-economy": "Premium Economy",
  business: "Business",
  first: "First",
};

const inputSchema = {
  from: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA airport code")
    .describe("Origin airport IATA code, e.g. JFK, LAX, BWI"),
  to: z
    .string()
    .regex(/^[A-Za-z]{3}$/, "must be a 3-letter IATA airport code")
    .describe("Destination airport IATA code"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")
    .describe("Departure date in YYYY-MM-DD format"),
  return_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe("Return date for round-trip search (YYYY-MM-DD). Omit for one-way."),
  flex_days: z
    .number()
    .int()
    .min(0)
    .max(60)
    .optional()
    .describe(
      "Search a window of date+N days. Each extra day multiplies the search workload, so keep small (1-7) unless the user explicitly wants flexibility.",
    ),
  cabins: z
    .array(z.enum(["economy", "premium", "business", "first"]))
    .optional()
    .describe(
      "Cabin classes to include. Omit to search all cabins. Most users want 'business' or 'first' for long-haul, 'economy' for short-haul.",
    ),
  nonstop: z.boolean().optional().describe("Only direct flights (0 stops)"),
  max_stops: z
    .number()
    .int()
    .min(0)
    .max(3)
    .optional()
    .describe("Maximum stops allowed. 0 = nonstop only, 1 = nonstop + 1-stop"),
  max_miles: z.number().int().positive().optional(),
  max_tax_usd: z.number().positive().optional(),
  banks: z
    .array(z.enum(["amex", "chase", "citi", "bilt", "capital-one"]))
    .optional()
    .describe(
      "Filter to programs that accept transfers from these banks' points (Amex MR, Chase UR, Citi TY, Bilt, Capital One Venture).",
    ),
  programs: z
    .array(z.string())
    .optional()
    .describe("Loyalty program codes (e.g. 'UA', 'AA', 'AC', 'BA'). Leave empty for all programs."),
  airlines: z
    .array(z.string())
    .optional()
    .describe(
      "Operating airline IATA codes (e.g. 'B6' for JetBlue, 'UA' for United). Strict: every segment must match.",
    ),
  aircraft: z
    .array(z.string())
    .optional()
    .describe(
      "Aircraft type substrings ('787', 'A350', '777-300'). Case-insensitive. Every segment must match one.",
    ),
  sort: z
    .enum(["miles", "duration", "tax", "departure", "cpp"])
    .optional()
    .describe(
      "Default 'miles' (cheapest first). Use 'cpp' to surface best value-per-point. Use 'departure' to sort chronologically.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Cap returned rows. Defaults to all matching results."),
  no_cache: z
    .boolean()
    .optional()
    .describe(
      "Bypass disk cache for cash quotes (1h TTL). Useful if the user thinks cash data is stale; otherwise leave unset.",
    ),
  skip_cash: z
    .boolean()
    .optional()
    .describe(
      "Skip Google Flights cash lookup. Faster (~3-8s saved) but no CPP. Use only when the user explicitly says they don't care about cash comparison.",
    ),
};

// ─── Output schema (agent-facing) ───────────────────────────────────────────

const outputSchema = {
  query: z
    .object({
      from: z.string(),
      to: z.string(),
      date: z.string(),
      return_date: z.string().nullable(),
      flex_days: z.number(),
      cabins: z.array(z.string()).nullable(),
      sort: z.string(),
      filters_applied: z.record(z.unknown()),
    })
    .describe("Echo of the resolved query so the agent can confirm what was searched."),
  summary: z
    .object({
      total_results: z.number(),
      programs_with_results: z.array(z.string()),
      by_stops: z.record(z.number()),
      by_cabin: z.record(
        z.object({
          count: z.number(),
          cheapest_miles: z.number().nullable(),
          cheapest_program: z.string().nullable(),
          best_cpp: z.number().nullable(),
          best_cpp_program: z.string().nullable(),
        }),
      ),
      best_value: z
        .object({
          row_id: z.string(),
          cpp: z.number(),
          cabin: z.string(),
          program: z.object({ code: z.string(), name: z.string() }),
          miles: z.number(),
          cash_usd: z.number(),
        })
        .nullable()
        .describe("Highest CPP redemption found. Often the user's best deal."),
      cash_baseline_usd: z
        .record(z.number())
        .describe("Lowest cash price seen per cabin. The 'going rate' anchor."),
      duration_seconds: z.number(),
    })
    .describe(
      "Headline numbers. Read this first; it tells you what's worth surfacing without traversing every row.",
    ),
  results: z.array(
    z
      .object({
        id: z.string().describe("Stable identifier for this row"),
        leg: z.enum(["outbound", "return"]).optional(),
        program: z.object({
          code: z.string().describe("Loyalty program code, e.g. 'AC' for Aeroplan"),
          name: z.string().describe("Full program name"),
        }),
        operating_airlines: z
          .array(z.string())
          .describe("IATA codes of operating carriers across segments"),
        route: z.object({
          path: z.string().describe("Dash-joined airport sequence, e.g. 'BWI-DEN-LAX'"),
          from: z.string(),
          to: z.string(),
        }),
        stops: z.number(),
        flights: z.array(
          z.object({
            flight_number: z.string(),
            aircraft: z.string(),
            from: z.string(),
            to: z.string(),
            depart_iso: z.string(),
            arrive_iso: z.string(),
            duration_minutes: z.number(),
            cabin: z.string(),
          }),
        ),
        depart_iso: z.string(),
        arrive_iso: z.string(),
        duration_minutes: z.number(),
        cross_days: z.number(),
        cabin: z.string(),
        miles: z.number(),
        tax_usd: z.number(),
        cash_usd: z.number().nullable(),
        cash_approximate: z
          .boolean()
          .nullable()
          .describe(
            "true = cash_usd is the airline's cheapest cash for the day, not an exact-time match. Real cash is at least this; CPP is a lower bound. false = exact-time match (±15 min). null = no cash data.",
          ),
        cpp: z
          .number()
          .nullable()
          .describe("Cents-per-point. Higher = better value redemption."),
        verdict: z
          .enum(["great", "good", "meh", "poor", "unknown"])
          .describe(
            "Precomputed value verdict from CPP. great=≥2.0¢, good=≥1.5¢, meh=≥1.0¢, poor=<1.0¢, unknown=no cash match.",
          ),
        seats_available: z.number(),
        transfer_partners: z.array(
          z.object({
            bank: z
              .string()
              .describe("Short bank code: Amex, Chase, Citi, Bilt, Capital One"),
            points_required: z.number(),
            bonus_percent: z.number(),
          }),
        ),
        booking_url: z.string().describe("Direct booking URL on the airline's site"),
      })
      .describe("One bookable award flight"),
  ),
};

// ─── Output transformation ──────────────────────────────────────────────────

const SHORT_BANK: Record<string, string> = {
  "American Exp Membership Rewards": "Amex",
  "Chase Ultimate Rewards": "Chase",
  "Citi ThankYou Rewards": "Citi",
  Bilt: "Bilt",
  "Capital One": "Capital One",
};

function rowId(r: EnrichedRow, idx: number): string {
  const date = r.segments[0].dt.slice(0, 10);
  const flight = r.segments[0].flight_number;
  const legSuffix = r.leg === "return" ? "-RT" : "";
  return `${r.programCode}-${date}-${flight}-${idx}${legSuffix}`;
}

function shapeRow(r: EnrichedRow, idx: number, hasReturn: boolean): unknown {
  const seg0 = r.segments[0];
  const segLast = r.segments[r.segments.length - 1];
  const cash = r.cashMatch;
  const cpp = r.cpp;
  const verdict: Verdict = verdictFromCpp(cpp);

  const operatingAirlines = [...new Set(
    r.segments.map((s) => s.flight_number.match(/^[A-Z0-9]{2}/)?.[0] ?? "??"),
  )];

  const flights = r.segments.map((s) => ({
    flight_number: s.flight_number,
    aircraft: s.aircraft,
    from: s.da,
    to: s.aa,
    depart_iso: s.dt,
    arrive_iso: s.at,
    duration_minutes: s.duration,
    cabin: s.cabin,
  }));

  const transfer_partners = (r.transfer ?? []).map((t) => ({
    bank: SHORT_BANK[t.bank] ?? t.code ?? t.bank,
    points_required: t.points,
    bonus_percent: t.bonus_percentage ?? 0,
  }));

  return {
    id: rowId(r, idx),
    ...(hasReturn ? { leg: r.leg } : {}),
    program: { code: r.programCode, name: r.programName },
    operating_airlines: operatingAirlines,
    route: {
      path: [seg0.da, ...r.segments.map((s) => s.aa)].join("-"),
      from: seg0.da,
      to: segLast.aa,
    },
    stops: r.segments.length - 1,
    flights,
    depart_iso: seg0.dt,
    arrive_iso: segLast.at,
    duration_minutes: r.duration,
    cross_days: r.cross_days,
    cabin: r.payment.cabin,
    miles: r.payment.miles,
    tax_usd: r.payment.tax,
    cash_usd: cash?.trip.price ?? null,
    cash_approximate: cash ? cash.approximate : null,
    cpp: cpp != null ? Number(cpp.toFixed(3)) : null,
    verdict,
    seats_available: r.payment.seats,
    transfer_partners,
    booking_url: r.url,
  };
}

interface Summary {
  total_results: number;
  programs_with_results: string[];
  by_stops: Record<string, number>;
  by_cabin: Record<
    string,
    {
      count: number;
      cheapest_miles: number | null;
      cheapest_program: string | null;
      best_cpp: number | null;
      best_cpp_program: string | null;
    }
  >;
  best_value: {
    row_id: string;
    cpp: number;
    cabin: string;
    program: { code: string; name: string };
    miles: number;
    cash_usd: number;
  } | null;
  cash_baseline_usd: Record<string, number>;
  duration_seconds: number;
}

function buildSummary(
  rows: EnrichedRow[],
  shaped: Array<ReturnType<typeof shapeRow>>,
  result: RunSearchResult,
  hasReturn: boolean,
): Summary {
  const by_stops: Record<string, number> = {};
  const by_cabin: Summary["by_cabin"] = {};
  const programs = new Set<string>();
  let bestValue: Summary["best_value"] = null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const shapedRow = shaped[i] as Record<string, unknown>;
    const stopsKey =
      r.segments.length - 1 >= 2 ? "2_plus" : String(r.segments.length - 1);
    by_stops[stopsKey] = (by_stops[stopsKey] ?? 0) + 1;
    programs.add(r.programCode);

    const cabin = r.payment.cabin;
    if (!by_cabin[cabin]) {
      by_cabin[cabin] = {
        count: 0,
        cheapest_miles: null,
        cheapest_program: null,
        best_cpp: null,
        best_cpp_program: null,
      };
    }
    const bucket = by_cabin[cabin];
    bucket.count += 1;
    if (
      bucket.cheapest_miles == null ||
      r.payment.miles < bucket.cheapest_miles
    ) {
      bucket.cheapest_miles = r.payment.miles;
      bucket.cheapest_program = r.programCode;
    }
    if (r.cpp != null) {
      if (bucket.best_cpp == null || r.cpp > bucket.best_cpp) {
        bucket.best_cpp = Number(r.cpp.toFixed(3));
        bucket.best_cpp_program = r.programCode;
      }
      if (
        r.cashMatch &&
        (bestValue == null || r.cpp > bestValue.cpp)
      ) {
        bestValue = {
          row_id: shapedRow.id as string,
          cpp: Number(r.cpp.toFixed(3)),
          cabin,
          program: { code: r.programCode, name: r.programName },
          miles: r.payment.miles,
          cash_usd: r.cashMatch.trip.price,
        };
      }
    }
  }

  // Cash baseline: lowest cash price seen per cabin, across the whole bucket.
  const cash_baseline_usd: Record<string, number> = {};
  for (const [key, trips] of result.cashByKey) {
    const cabin = key.split("|")[3];
    for (const t of trips) {
      if (cash_baseline_usd[cabin] === undefined || t.price < cash_baseline_usd[cabin]) {
        cash_baseline_usd[cabin] = t.price;
      }
    }
  }

  void hasReturn; // kept for future per-leg summaries
  return {
    total_results: rows.length,
    programs_with_results: [...programs].sort(),
    by_stops,
    by_cabin,
    best_value: bestValue,
    cash_baseline_usd,
    duration_seconds: Number((result.durationMs / 1000).toFixed(2)),
  };
}

// ─── Tool handler ───────────────────────────────────────────────────────────

interface ToolErrorResponse {
  error: {
    code: string;
    message: string;
    recoverable: boolean;
    suggested_action?: string;
  };
}

function errorResult(
  code: string,
  message: string,
  recoverable = false,
  suggestedAction?: string,
): { content: Array<{ type: "text"; text: string }>; isError: true; structuredContent: ToolErrorResponse } {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true,
    structuredContent: {
      error: { code, message, recoverable, ...(suggestedAction ? { suggested_action: suggestedAction } : {}) },
    },
  };
}

interface SearchInput {
  from: string;
  to: string;
  date: string;
  return_date?: string;
  flex_days?: number;
  cabins?: Array<"economy" | "premium" | "business" | "first">;
  nonstop?: boolean;
  max_stops?: number;
  max_miles?: number;
  max_tax_usd?: number;
  banks?: Array<"amex" | "chase" | "citi" | "bilt" | "capital-one">;
  programs?: string[];
  airlines?: string[];
  aircraft?: string[];
  sort?: SortKey;
  limit?: number;
  no_cache?: boolean;
  skip_cash?: boolean;
}

async function handleSearch(rawInput: unknown) {
  const input = rawInput as SearchInput;
  const cabins: Cabin[] | undefined = input.cabins?.map((c) => cabinShortToFull[c]);
  const filters: SearchFilters = {
    exactStops: input.nonstop ? 0 : undefined,
    maxStops: input.max_stops,
    maxMiles: input.max_miles,
    maxTax: input.max_tax_usd,
    banks: input.banks,
    programs: input.programs,
    airlines: input.airlines,
    aircraft: input.aircraft,
  };

  const opts: RunSearchOptions = {
    from: input.from.toUpperCase(),
    to: input.to.toUpperCase(),
    date: input.date,
    returnDate: input.return_date,
    flexDays: input.flex_days,
    cabins,
    filters,
    sort: input.sort ?? "miles",
    limit: input.limit,
    noCache: input.no_cache,
    skipCash: input.skip_cash,
  };

  let result: RunSearchResult;
  try {
    result = await runSearch(opts);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (msg.includes("auth-setup")) {
      return errorResult(
        "auth_setup_required",
        "PointsYeah session has expired and there is no saved Playwright session to silently refresh from. The MCP host operator must run `npm run auth-setup` once to re-authenticate.",
        false,
        "Tell the user the server-side login expired and the operator needs to refresh it; cannot be self-served from the agent.",
      );
    }
    if (/4\d\d|expired|token/i.test(msg)) {
      return errorResult("auth_expired", msg, false);
    }
    if (/timeout/i.test(msg)) {
      return errorResult("upstream_timeout", msg, true, "Retry the call; PointsYeah's backend is occasionally slow.");
    }
    return errorResult("internal_error", msg);
  }

  const hasReturn = !!input.return_date;
  const shaped = result.rows.map((r, i) => shapeRow(r, i, hasReturn));
  const summary = buildSummary(result.rows, shaped, result, hasReturn);

  const filters_applied: Record<string, unknown> = {};
  if (filters.exactStops !== undefined) filters_applied.nonstop = true;
  if (filters.maxStops !== undefined) filters_applied.max_stops = filters.maxStops;
  if (filters.maxMiles !== undefined) filters_applied.max_miles = filters.maxMiles;
  if (filters.maxTax !== undefined) filters_applied.max_tax_usd = filters.maxTax;
  if (filters.banks?.length) filters_applied.banks = filters.banks;
  if (filters.programs?.length) filters_applied.programs = filters.programs;
  if (filters.airlines?.length) filters_applied.airlines = filters.airlines;
  if (filters.aircraft?.length) filters_applied.aircraft = filters.aircraft;

  const structuredContent = {
    query: {
      from: opts.from,
      to: opts.to,
      date: opts.date,
      return_date: opts.returnDate ?? null,
      flex_days: opts.flexDays ?? 0,
      cabins: cabins ?? null,
      sort: opts.sort ?? "miles",
      filters_applied,
    },
    summary,
    results: shaped,
  };

  // Also produce a short text summary for clients that don't render structured content.
  const textSummary = summary.total_results === 0
    ? `No award availability found for ${opts.from} → ${opts.to} on ${opts.date}.`
    : `Found ${summary.total_results} award flights for ${opts.from} → ${opts.to} on ${opts.date}` +
      (summary.best_value
        ? `. Best value: ${summary.best_value.miles.toLocaleString()} ${summary.best_value.program.code} miles + cash $${summary.best_value.cash_usd} (${summary.best_value.cpp.toFixed(2)}¢/pt) in ${summary.best_value.cabin}.`
        : ".");

  return {
    content: [{ type: "text" as const, text: textSummary }],
    structuredContent,
  };
}

// ─── Tool description (agent-facing prose) ──────────────────────────────────

const TOOL_DESCRIPTION = `\
Search award flight availability and compare against Google Flights cash prices to determine whether redeeming points is a good deal.

WHEN TO USE:
- User asks about award flights, miles, points redemptions, or "should I use points or cash?"
- User asks "what's the cheapest way to get from X to Y on date Z?" — call this with both the cash and points lens.
- User wants to find sweet-spot redemptions on a route.

OUTPUT INTERPRETATION (read in order):
1. summary.best_value — the highest cents-per-point (CPP) result. Usually the headline answer.
2. summary.by_cabin — cheapest miles and best CPP per cabin class.
3. summary.cash_baseline_usd — what the equivalent cash flight costs (the "going rate"); use this to explain why a CPP is good or bad.
4. results[] — individual bookable awards, sorted by the chosen sort key.

PER-RESULT FIELDS:
- verdict: precomputed CPP rating ("great" ≥2.0¢, "good" ≥1.5¢, "meh" ≥1.0¢, "poor" <1.0¢, "unknown" = no cash match). Use this verbatim — don't re-derive.
- cash_approximate: TRUE means cash_usd is the airline's cheapest cash that day (not an exact-time match). The CPP shown is a lower bound — actual value is at least that good. Mention this caveat if surfacing the row.
- transfer_partners: which banks' rewards transfer to this loyalty program. If the user mentions "I have Amex points," filter results where transfer_partners[].bank == "Amex".
- booking_url: link the user can click to book directly on the airline's site.
- seats_available: rough award seat count. Often 0–9. Low numbers mean book quickly.

FILTERING TIPS:
- Most users prefer fewer stops. Default to nonstop=true or max_stops=1 if the user hasn't specified.
- For long-haul (>6h flight), default to including 'business' cabin even if user says "cheapest" — point-cost-per-cabin gap is enormous and value is much higher.
- Use the 'banks' filter when the user mentions which credit cards they hold.
- Use 'programs' (e.g., 'AC', 'UA') only if user names a specific airline they want to redeem with.

PERFORMANCE:
- Typical call: 5–30 seconds. Slow because it polls PointsYeah and scrapes Google Flights.
- Set skip_cash=true to skip the Google lookup if the user only wants miles costs (saves ~3-8s).
- A flex_days search multiplies workload; keep flex_days ≤ 7 unless explicitly asked.

ERRORS:
- auth_setup_required: server-side credentials need refresh by the operator. Not user-fixable.
- upstream_timeout: retry once before giving up.
- no results: not an error; summary.total_results is 0. Suggest changing dates or filters.`;

// ─── Server wiring ──────────────────────────────────────────────────────────

function buildServer(): McpServer {
  const server = new McpServer({ name: "pointsyeah", version: "1.0.0" });

  server.registerTool(
    "search_flights",
    {
      title: "Search award flights with points-vs-cash analysis",
      description: TOOL_DESCRIPTION,
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    // The SDK derives a generic from inputSchema which our hand-written
    // SearchInput doesn't precisely match (zod ZodString vs string). The
    // runtime contract is correct — cast to bypass the SDK's overly strict
    // generic inference.
    handleSearch as Parameters<typeof server.registerTool>[2],
  );

  return server;
}

function checkAuth(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === AUTH_TOKEN;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  if (DEBUG) {
    console.log(
      `[mcp ${reqId}] ${req.method} ${req.url} accept=${req.headers.accept ?? "-"}`,
    );
  }

  if (req.url !== "/mcp") {
    res.writeHead(404).end("not found");
    return;
  }
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("unauthorized");
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildServer();
    await server.connect(transport);
    let body: unknown;
    if (req.method === "POST") {
      body = await readBody(req);
      if (DEBUG) {
        const bodyStr = JSON.stringify(body);
        console.log(`[mcp ${reqId}] body=${bodyStr.slice(0, 300)}${bodyStr.length > 300 ? "…" : ""}`);
      }
    }
    await transport.handleRequest(req, res, body);
    if (DEBUG) console.log(`[mcp ${reqId}] -> ${res.statusCode}`);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (e) {
    console.error(`[mcp ${reqId}] failed:`, e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        }),
      );
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp] pointsyeah MCP listening on http://${HOST}:${PORT}/mcp`);
  if (DEBUG) console.log("[mcp] DEBUG logging enabled");
});
