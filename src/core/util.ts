import { createHash } from "node:crypto";
import { InterpolationError, type Context } from "./types";

/* ---------- canonical json + hash ---------- */

import { canonicalJson } from "./json";
export { canonicalJson };

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function hashSnapshot(snap: Record<string, unknown>): string {
  const { hash: _hash, ...rest } = snap;
  void _hash;
  return sha256(canonicalJson(rest));
}

/* ---------- redaction ---------- */

const SENSITIVE = /(authorization|token|api[_-]?key|password|secret)/i;

export function redact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(redact) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redact(val);
    }
    return out as T;
  }
  return v;
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/* ---------- path helpers ---------- */

export function getPath(obj: unknown, path: string[]): { found: boolean; value?: unknown } {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

export function setPath(obj: unknown, path: string[], value: unknown): void {
  let cur = obj as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) cur = cur[path[i]] as Record<string, unknown>;
  cur[path[path.length - 1]] = value;
}

export function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** every dot-path (objects only, plus array indices) available in a JSON value */
export function listPaths(v: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.push(p);
      out.push(...listPaths(val, p));
    }
  }
  return out;
}

/* ---------- interpolation ---------- */

const ONLY = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g;

function lookup(expr: string, ctx: Context, stepId: string): unknown {
  const parts = expr.split(".");
  const root = parts[0];
  let found: { found: boolean; value?: unknown };
  if (root === "inputs") found = getPath(ctx.inputs, parts.slice(1));
  else if (root === "steps") found = getPath(ctx.steps, parts.slice(1));
  else found = { found: false };
  if (!found.found) {
    throw new InterpolationError(
      `Unknown path in template "{{${expr}}}" (step "${stepId}"). Check the step id / key name, or run an earlier step first.`,
    );
  }
  return found.value;
}

export function interpolate(value: unknown, ctx: Context, stepId: string): unknown {
  if (typeof value === "string") {
    const only = ONLY.exec(value);
    if (only) return clone(lookup(only[1], ctx, stepId));
    return value.replace(ANY, (_m, expr: string) => {
      const r = lookup(expr, ctx, stepId);
      return typeof r === "string" ? r : JSON.stringify(r);
    });
  }
  if (Array.isArray(value)) return value.map((x) => interpolate(x, ctx, stepId));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = interpolate(v, ctx, stepId);
    return out;
  }
  return value;
}
