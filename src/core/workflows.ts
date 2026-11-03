import fs from "node:fs";
import path from "node:path";
import { TmError } from "./types";

/** Resolve "demo-tracker" | "workflows/demo-tracker.workflow.json" | any path to parsed JSON */
export function loadWorkflowFile(ref: string, cwd = process.cwd()): unknown {
  const candidates = [ref, path.join(cwd, "workflows", `${ref}.workflow.json`)];
  for (const f of candidates) {
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      try {
        return JSON.parse(fs.readFileSync(f, "utf8"));
      } catch (e) {
        throw new TmError(`Workflow file ${f} is not valid JSON: ${(e as Error).message}`, 2);
      }
    }
  }
  throw new TmError(`Workflow "${ref}" not found. Looked in: ${candidates.join(", ")}. Try: ls workflows/`, 2);
}

/** Safe variant for the HTTP API: only names from ./workflows are allowed */
export function loadNamedWorkflow(name: string, cwd = process.cwd()): unknown {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new TmError(`Invalid workflow name "${name}"`, 2);
  return loadWorkflowFile(path.join(cwd, "workflows", `${name}.workflow.json`), cwd);
}

export function listWorkflows(cwd = process.cwd()): string[] {
  const dir = path.join(cwd, "workflows");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".workflow.json"))
    .map((f) => f.replace(".workflow.json", ""));
}
