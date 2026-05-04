// Diagnostic: compare what the API returns logged-out vs logged-in.
// Run: npx tsx scripts/compare-auth.ts JFK LAX 2026-06-09
import { search, type ProgramResult, type Route } from "../src/pointsyeah.ts";
import { ensureFreshIdToken } from "../src/auth.ts";

try {
  process.loadEnvFile(".env");
} catch {}

const [dep, arr, date] = process.argv.slice(2);
if (!dep || !arr || !date) {
  console.error("Usage: tsx scripts/compare-auth.ts <DEP> <ARR> <YYYY-MM-DD>");
  process.exit(1);
}

interface Summary {
  programs: number;
  routes: number;
  cabins: Record<string, number>;
  minMilesByCabin: Record<string, number>;
  uniqueMiles: number[];
  sampleRoute: { program: string; cabin: string; miles: number; tax: number; flight: string } | null;
}

function summarize(programs: ProgramResult[]): Summary {
  const allRoutes: Route[] = programs.flatMap((p) => p.routes);
  const cabins: Record<string, number> = {};
  const minMilesByCabin: Record<string, number> = {};
  const milesSet = new Set<number>();
  for (const r of allRoutes) {
    const c = r.payment.cabin;
    cabins[c] = (cabins[c] ?? 0) + 1;
    if (minMilesByCabin[c] === undefined || r.payment.miles < minMilesByCabin[c]) {
      minMilesByCabin[c] = r.payment.miles;
    }
    milesSet.add(r.payment.miles);
  }
  const sample = allRoutes[0]
    ? {
        program: programs.find((p) => p.routes.includes(allRoutes[0]))?.program ?? "?",
        cabin: allRoutes[0].payment.cabin,
        miles: allRoutes[0].payment.miles,
        tax: allRoutes[0].payment.tax,
        flight: allRoutes[0].segments.map((s) => s.flight_number).join("/"),
      }
    : null;
  return {
    programs: programs.length,
    routes: allRoutes.length,
    cabins,
    minMilesByCabin,
    uniqueMiles: [...milesSet].sort((a, b) => a - b),
    sampleRoute: sample,
  };
}

async function run(label: string, withAuth: boolean): Promise<Summary> {
  const saved = process.env.POINTSYEAH_ID_TOKEN;
  if (!withAuth) delete process.env.POINTSYEAH_ID_TOKEN;
  else if (!saved) process.env.POINTSYEAH_ID_TOKEN = await ensureFreshIdToken();
  console.log(`\n=== ${label} ===`);
  const programs = await search(
    { departure: dep, arrival: arr, departDate: date },
    { pollIntervalMs: 200, timeoutMs: 60_000 },
  );
  if (saved !== undefined) process.env.POINTSYEAH_ID_TOKEN = saved;
  else delete process.env.POINTSYEAH_ID_TOKEN;
  const s = summarize(programs);
  console.log(JSON.stringify(s, null, 2));
  return s;
}

const out = await run("LOGGED OUT", false);
const inn = await run("LOGGED IN", true);

console.log("\n=== DIFF ===");
console.log(
  `programs: out=${out.programs} in=${inn.programs}` +
    `   routes: out=${out.routes} in=${inn.routes}`,
);
console.log("min miles by cabin (out / in):");
const cabins = new Set([...Object.keys(out.minMilesByCabin), ...Object.keys(inn.minMilesByCabin)]);
for (const c of cabins) {
  console.log(`  ${c}: ${out.minMilesByCabin[c] ?? "—"} / ${inn.minMilesByCabin[c] ?? "—"}`);
}
const sameMiles =
  out.uniqueMiles.length === inn.uniqueMiles.length &&
  out.uniqueMiles.every((m, i) => m === inn.uniqueMiles[i]);
console.log(`unique-miles arrays identical? ${sameMiles}`);
