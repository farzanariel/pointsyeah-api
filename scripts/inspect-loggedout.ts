// Pull a logged-out result and inspect for completeness signals.
import { search } from "../src/pointsyeah.ts";

delete process.env.POINTSYEAH_ID_TOKEN;

const programs = await search(
  { departure: "JFK", arrival: "LAX", departDate: "2026-06-09" },
  { pollIntervalMs: 200, timeoutMs: 60_000 },
);

const allRoutes = programs.flatMap((p) =>
  p.routes.map((r) => ({ program: p.program, code: p.code, ...r })),
);

console.log(`Programs: ${programs.length}, routes: ${allRoutes.length}`);
console.log("\nProgram codes seen:", programs.map((p) => p.code).sort().join(", "));

const sample = allRoutes[0];
console.log("\nFull sample route (raw):");
console.log(JSON.stringify(sample, null, 2));

console.log("\n--- Completeness checks ---");
const withTransfer = allRoutes.filter((r) => r.transfer && r.transfer.length > 0);
const withUrl = allRoutes.filter((r) => r.url && r.url.length > 0);
const withCashUrl = allRoutes.filter((r) => r.cash_ticket_url && r.cash_ticket_url.length > 0);
const withSeats = allRoutes.filter((r) => r.payment.seats && r.payment.seats > 0);
const withCashPrice = allRoutes.filter((r) => r.payment.cash_price && r.payment.cash_price > 0);
const withFlightNo = allRoutes.filter((r) => r.segments.every((s) => s.flight_number && s.flight_number.length >= 3));
const withRealAircraft = allRoutes.filter((r) => r.segments.some((s) => s.aircraft && !/unknown/i.test(s.aircraft)));

const pct = (n: number) => `${n}/${allRoutes.length} (${Math.round((100 * n) / allRoutes.length)}%)`;
console.log(`transfer partners present:  ${pct(withTransfer.length)}`);
console.log(`booking url present:        ${pct(withUrl.length)}`);
console.log(`cash_ticket_url present:    ${pct(withCashUrl.length)}`);
console.log(`seats > 0:                  ${pct(withSeats.length)}`);
console.log(`cash_price > 0:             ${pct(withCashPrice.length)}`);
console.log(`flight numbers all set:     ${pct(withFlightNo.length)}`);
console.log(`aircraft populated:         ${pct(withRealAircraft.length)}`);

console.log("\n--- Stops distribution ---");
const stops: Record<number, number> = {};
for (const r of allRoutes) {
  const k = r.segments.length - 1;
  stops[k] = (stops[k] ?? 0) + 1;
}
console.log(stops);

console.log("\n--- Three random samples ---");
for (const i of [0, Math.floor(allRoutes.length / 2), allRoutes.length - 1]) {
  const r = allRoutes[i];
  console.log(
    `[${i}] ${r.program} | ${r.payment.cabin} | ${r.payment.miles}mi + $${r.payment.tax} | ${r.segments.map((s) => s.flight_number).join("/")} | seats=${r.payment.seats} | url=${(r.url ?? "").slice(0, 50)}`,
  );
}
