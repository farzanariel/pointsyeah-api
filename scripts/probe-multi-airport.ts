// Probe what payload shapes PointsYeah's API accepts for multi-airport / metro
// searches. Tries several variants and reports back which return real data
// (small `seats` numbers) vs teaser/empty/error.
import { createCipheriv } from "node:crypto";
import { ensureFreshIdToken } from "../src/auth.ts";

const KEY_PREFIX = "LefjQ2pEXmiy/nNZvhJ43i8";
const KEY_SUFFIX = "YHYbn1hOuAgA=";
const DEFAULT_KEY_SECTION = "hJuaknzb";
const STATIC_IV = Buffer.from("1020304050607080", "utf8");
const API_BASE = "https://api2.pointsyeah.com";

function decodeJwtPayload(jwt: string): any {
  const parts = jwt.split(".");
  const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  return JSON.parse(Buffer.from(b64 + pad, "base64").toString("utf8"));
}
function encrypt(plaintext: string, section: string) {
  const key = Buffer.from(KEY_PREFIX + section + KEY_SUFFIX, "base64");
  const c = createCipheriv("aes-256-cbc", key, STATIC_IV);
  return Buffer.concat([c.update(plaintext, "utf8"), c.final()]).toString("base64");
}

const token = await ensureFreshIdToken();
const jti = decodeJwtPayload(token).jti as string;
const section = jti.slice(0, 8);

const HEADERS = {
  "content-type": "application/json",
  origin: "https://www.pointsyeah.com",
  referer: "https://www.pointsyeah.com/",
  authorization: token,
};

async function fire(label: string, segment: any) {
  const plaintext = JSON.stringify({
    search_type: "one_way",
    cabins: ["Economy", "Premium Economy", "Business", "First"],
    segments: [segment],
    passengers_v2: { adults: 1, children: 0 },
    source: "mobile",
  });
  const data = encrypt(plaintext, DEFAULT_KEY_SECTION);
  const enc = encrypt(plaintext, section);
  const r = await fetch(`${API_BASE}/flight/search/create_task`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({ data, encrypted: enc }),
  });
  if (!r.ok) {
    console.log(`[${label}] HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const j = await r.json() as any;
  if (!j.success) {
    console.log(`[${label}] create_task !success: ${JSON.stringify(j).slice(0, 300)}`);
    return;
  }
  const taskId = j.data.task_id;

  // Poll up to ~75s
  const start = Date.now();
  let snap: any = null;
  while (Date.now() - start < 75_000) {
    const fr = await fetch(`${API_BASE}/flight/search/fetch_result`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({ task_id: taskId }),
    });
    snap = await fr.json();
    if (snap?.data?.status === "done" || snap?.data?.status === "completed") break;
    await new Promise((res) => setTimeout(res, 200));
  }

  const result = snap?.data?.result ?? [];
  const totalRoutes = result.reduce((s: number, p: any) => s + (p.routes?.length ?? 0), 0);
  const sampleSeats = result[0]?.routes?.[0]?.payment?.seats;
  const departures = new Set<string>();
  const arrivals = new Set<string>();
  for (const p of result) {
    departures.add(p.departure);
    arrivals.add(p.arrival);
  }
  console.log(
    `[${label}] status=${snap?.data?.status} programs=${result.length} routes=${totalRoutes} ` +
      `sampleSeats=${sampleSeats} deps=${[...departures].join(",")} arrs=${[...arrivals].join(",")}`,
  );
}

const date = "2026-06-09";
const tests: Array<[string, any]> = [
  ["control-JFK-LAX", { departure: "JFK", arrival: "LAX", departure_date: { from: date, to: date } }],
  ["metro-NYC-LAX",   { departure: "NYC", arrival: "LAX", departure_date: { from: date, to: date } }],
  ["comma-JFK,EWR",   { departure: "JFK,EWR,LGA", arrival: "LAX", departure_date: { from: date, to: date } }],
  ["array-departures",{ departures: ["JFK","EWR","LGA"], arrival: "LAX", departure_date: { from: date, to: date } }],
  ["array-departure-field", { departure: ["JFK","EWR","LGA"], arrival: "LAX", departure_date: { from: date, to: date } }],
  ["airports-field",  { departure_airports: ["JFK","EWR","LGA"], arrival_airports: ["LAX"], departure_date: { from: date, to: date } }],
];

for (const [label, seg] of tests) {
  try { await fire(label, seg); } catch (e) { console.log(`[${label}] threw: ${(e as Error).message}`); }
  await new Promise((r) => setTimeout(r, 8000));
}
