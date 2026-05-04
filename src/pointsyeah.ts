import { createCipheriv } from "node:crypto";

// Constants reverse-engineered from chunk 7316 of www.pointsyeah.com.
// The site builds the AES-256-CBC key by sandwiching a "key section" between
// two static halves and base64-decoding the result. For logged-out users the
// key section defaults to "hJuaknzb"; logged-in it's idToken.payload.jti[0:8].
const KEY_PREFIX = "LefjQ2pEXmiy/nNZvhJ43i8";
const KEY_SUFFIX = "YHYbn1hOuAgA=";
const DEFAULT_KEY_SECTION = "hJuaknzb";
const STATIC_IV = Buffer.from("1020304050607080", "utf8"); // 16 bytes

const API_BASE = "https://api2.pointsyeah.com";

const BROWSER_HEADERS = {
  "content-type": "application/json",
  origin: "https://www.pointsyeah.com",
  referer: "https://www.pointsyeah.com/",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
};

interface AuthContext {
  idToken: string;
  /** First 8 chars of the JWT's `jti` claim — this is what the site uses as
   *  the AES key section for the `encrypted` field on logged-in requests. */
  parseKeySection: string;
  /** True if the JWT's exp is in the past. */
  expired: boolean;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("idToken is not a JWT (expected 3 dot-separated parts)");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
}

export function getAuthContext(): AuthContext | null {
  const token = process.env.POINTSYEAH_ID_TOKEN?.trim();
  if (!token) return null;
  const payload = decodeJwtPayload(token);
  const jti = typeof payload.jti === "string" ? payload.jti : "";
  if (jti.length < 8) {
    throw new Error("idToken payload has no usable `jti` claim");
  }
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  return {
    idToken: token,
    parseKeySection: jti.slice(0, 8),
    expired: exp > 0 && exp * 1000 < Date.now(),
  };
}

function buildKey(section: string): Buffer {
  return Buffer.from(KEY_PREFIX + section + KEY_SUFFIX, "base64");
}

function encryptPayload(plaintext: string, section = DEFAULT_KEY_SECTION): string {
  const cipher = createCipheriv("aes-256-cbc", buildKey(section), STATIC_IV);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return enc.toString("base64");
}

export type Cabin = "Economy" | "Premium Economy" | "Business" | "First";

export interface SearchInput {
  departure: string; // IATA, e.g. "LAX"
  arrival: string; // IATA, e.g. "PHL"
  /** YYYY-MM-DD */
  departDate: string;
  /** YYYY-MM-DD; defaults to departDate (single-day search) */
  departDateTo?: string;
  cabins?: Cabin[];
  adults?: number;
  children?: number;
}

export interface CreateTaskResponse {
  code: number;
  success: boolean;
  data: { task_id: string; total_sub_tasks: number; status: string };
}

export interface RouteSegment {
  flight_number: string;
  aircraft: string;
  dt: string; // departure datetime
  da: string; // departure airport
  at: string; // arrival datetime
  aa: string; // arrival airport
  layover: number; // minutes
  cabin: string;
  duration: number; // minutes
}

export interface Route {
  payment: {
    currency: string;
    tax: number;
    miles: number;
    cabin: string;
    seats: number;
    cash_price: number;
  };
  segments: RouteSegment[];
  duration: number;
  cross_days: number;
  program: string;
  code: string;
  url: string;
  cash_ticket_url: string;
  extra: { booking_code: string; left_seats: Record<string, number> };
  transfer: Array<{
    bank: string;
    points: number;
    actual_points: number;
    bonus_percentage: number;
    bonus_end_date: string | null;
    url: string;
    code: string;
  }>;
}

export interface ProgramResult {
  program: string;
  code: string;
  date: string;
  departure: string;
  arrival: string;
  routes: Route[];
}

export interface FetchResultResponse {
  code: number;
  success: boolean;
  data: { result: ProgramResult[]; status: "processing" | "done" | "completed" };
}

const TERMINAL_STATUSES = new Set(["done", "completed"]);

function buildPlaintext(input: SearchInput): string {
  const cabins: Cabin[] = input.cabins ?? [
    "Economy",
    "Premium Economy",
    "Business",
    "First",
  ];
  return JSON.stringify({
    search_type: "one_way",
    cabins,
    segments: [
      {
        arrival: input.arrival,
        departure: input.departure,
        departure_date: {
          from: input.departDate,
          to: input.departDateTo ?? input.departDate,
        },
      },
    ],
    passengers_v2: {
      adults: input.adults ?? 1,
      children: input.children ?? 0,
    },
    source: "mobile",
  });
}

function authHeaders(auth: AuthContext | null): Record<string, string> {
  return auth ? { ...BROWSER_HEADERS, authorization: auth.idToken } : BROWSER_HEADERS;
}

export async function createTask(
  input: SearchInput,
  auth: AuthContext | null = getAuthContext(),
): Promise<CreateTaskResponse> {
  const plaintext = buildPlaintext(input);
  const data = encryptPayload(plaintext); // default key section
  const encrypted = auth ? encryptPayload(plaintext, auth.parseKeySection) : data;

  const res = await fetch(`${API_BASE}/flight/search/create_task`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ data, encrypted }),
  });
  if (!res.ok) {
    throw new Error(`create_task ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as CreateTaskResponse;
}

export async function fetchResultOnce(
  taskId: string,
  auth: AuthContext | null = getAuthContext(),
): Promise<FetchResultResponse> {
  const res = await fetch(`${API_BASE}/flight/search/fetch_result`, {
    method: "POST",
    headers: authHeaders(auth),
    body: JSON.stringify({ task_id: taskId }),
  });
  if (!res.ok) {
    throw new Error(`fetch_result ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as FetchResultResponse;
}

export interface PollOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onUpdate?: (snapshot: FetchResultResponse) => void;
}

export async function search(
  input: SearchInput,
  opts: PollOptions = {},
): Promise<ProgramResult[]> {
  // Server already long-polls (~3s server-side wait when no new data).
  // Default to back-to-back polls with a tiny floor to avoid hammering on
  // pathological fast-empty responses.
  const { pollIntervalMs = 50, timeoutMs = 60_000, onUpdate } = opts;
  const auth = getAuthContext();
  if (auth?.expired) {
    console.warn(
      "[pointsyeah] WARNING: POINTSYEAH_ID_TOKEN is expired. Trying anyway — if results are synthetic, refresh the token.",
    );
  }

  const created = await createTask(input, auth);
  if (!created.success) throw new Error(`create_task failed: ${JSON.stringify(created)}`);
  const taskId = created.data.task_id;

  const start = Date.now();
  const merged = new Map<string, ProgramResult>();
  while (true) {
    const snap = await fetchResultOnce(taskId, auth);
    if (snap.success && snap.data?.result) {
      for (const r of snap.data.result) {
        const key = `${r.code}|${r.date}|${r.departure}|${r.arrival}`;
        const existing = merged.get(key);
        if (!existing || r.routes.length > existing.routes.length) merged.set(key, r);
      }
    }
    onUpdate?.(snap);
    if (snap.data?.status && TERMINAL_STATUSES.has(snap.data.status)) break;
    if (Date.now() - start > timeoutMs) break;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return [...merged.values()];
}
