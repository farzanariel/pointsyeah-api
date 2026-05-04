import { createTask, fetchResultOnce } from "./pointsyeah.ts";
import { writeFileSync } from "node:fs";

const created = await createTask({
  departure: "JFK",
  arrival: "LAX",
  departDate: "2026-06-09",
});
console.log("create_task:", created);

const taskId = created.data.task_id;
const snapshots: any[] = [];
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const snap = await fetchResultOnce(taskId);
  snapshots.push(snap);
  const programs = snap.data?.result?.length ?? 0;
  const routes = snap.data?.result?.reduce((s, p) => s + p.routes.length, 0) ?? 0;
  console.log(`poll ${i}: status=${snap.data?.status} programs=${programs} routes=${routes}`);
  if (snap.data?.status === "done" || snap.data?.status === "completed") break;
}

writeFileSync("/tmp/py-dump.json", JSON.stringify(snapshots, null, 2));
console.log(`\nSaved ${snapshots.length} snapshots to /tmp/py-dump.json`);

// Pull every distinct miles value we saw
const allMiles = new Set<number>();
for (const s of snapshots) {
  for (const p of s.data?.result ?? []) {
    for (const r of p.routes ?? []) allMiles.add(r.payment?.miles);
  }
}
console.log("Distinct miles values seen:", [...allMiles].sort((a, b) => a - b));
