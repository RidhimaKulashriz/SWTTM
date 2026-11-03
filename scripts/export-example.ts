// Exports the runs currently in ./timemachine (produced by `swy-tm demo`) into examples/ so the static UI has real data.
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/core/store";
import { mockLedger } from "../src/executors/executor";

const store = new Store(process.argv[2] ?? "timemachine");
const runs = store.listRuns().filter((m) => m.mock).reverse(); // oldest first
const out = {
  source: "swy-tm demo (MOCK executor, in-memory tracker — not a real API)",
  generatedAt: new Date().toISOString(),
  runs: runs.map((m) => ({ manifest: m, snapshots: store.readSnapshots(m.runId) })),
  ledger: mockLedger(store),
};
const dest = path.resolve("examples/snapshots");
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const m of runs) fs.cpSync(store.runDir(m.runId), path.join(dest, m.runId), { recursive: true });
fs.writeFileSync(path.join(dest, "demo.json"), JSON.stringify(out, null, 2));
console.log(`exported ${runs.length} runs → ${dest}`);
