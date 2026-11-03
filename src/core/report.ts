import type { DiffResult } from "./diff";

/** Browser-safe formatting helpers shared by the CLI and the web UI. */
export function fmtValue(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (v && typeof v === "object" && !Array.isArray(v) && "message" in v) {
    const e = v as { category?: string; message: string };
    const m = e.message.length > 60 ? e.message.slice(0, 57) + "…" : e.message;
    return `{${e.category ?? "error"} · ${m}}`;
  }
  const s = JSON.stringify(v);
  return s.length > 90 ? s.slice(0, 87) + "…" : s;
}

export function diffToMarkdown(d: DiffResult): string {
  const out = [`### Divergence ${d.a} → ${d.b}`, ""];
  for (const s of d.steps) {
    out.push(`- **step ${s.index} ${s.stepId}** — ${s.state}`);
    for (const ch of s.changes.filter((x) => !x.volatile && s.state === "diverged")) {
      out.push(`  - \`${ch.path}\`: ${fmtValue(ch.before)} → ${fmtValue(ch.after)}`);
    }
  }
  out.push("", `volatile fields ignored: ${d.volatile.length}`);
  return out.join("\n");
}
