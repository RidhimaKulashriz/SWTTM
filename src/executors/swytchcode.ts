import { spawn, spawnSync } from "node:child_process";
import type { ExecResult, Executor } from "../core/types";

export const INSTALL_HINT = "curl -fsSL https://cli.swytchcode.com/install.sh | sh   (Windows: irm https://cli.swytchcode.com/install.ps1 | iex)";

export function detectBinary(): string | null {
  for (const bin of ["swytchcode", "swy"]) {
    const r = spawnSync(bin, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return bin;
  }
  return null;
}

/**
 * Real executor: shells out to `swytchcode exec --json` with
 * {"tool": <canonical_id>, "args": <flat args>} on stdin (verified in docs/verified-facts.md).
 * Credentials are never read or logged by this code; Swytchcode manages them (`swytchcode auth connect`).
 */
export class SwytchcodeExecutor implements Executor {
  name = "swytchcode" as const;
  mock = false;
  constructor(private cwd: string = /* turbopackIgnore: true */ process.cwd()) {}

  async exec(canonicalId: string, input: unknown, ctx: { dryRun: boolean }): Promise<ExecResult> {
    const bin = detectBinary();
    if (!bin) {
      return { ok: false, error: { category: "missing_binary", message: `swytchcode CLI not found on PATH. Install: ${INSTALL_HINT}`, retryable: false } };
    }
    const args = ["exec", "--json"];
    if (ctx.dryRun) args.push("--dry-run");
    return new Promise<ExecResult>((resolve) => {
      const p = spawn(bin, args, { cwd: this.cwd, env: process.env });
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", (e) => resolve({ ok: false, error: { category: "spawn", message: e.message } }));
      p.on("close", (code) => {
        if (code === 0) {
          const t = out.trim();
          try {
            return resolve({ ok: true, output: t ? JSON.parse(t) : null });
          } catch {
            return resolve({ ok: true, output: t });
          }
        }
        // classified error JSON is one line on stderr, mixed with log lines
        for (const line of err.split("\n").reverse()) {
          const l = line.trim();
          if (!l.startsWith("{")) continue;
          try {
            const j = JSON.parse(l) as Record<string, unknown>;
            if (typeof j.error === "string") {
              return resolve({
                ok: false,
                error: {
                  category: j.category as string | undefined,
                  message: j.error,
                  retryable: j.retryable as boolean | undefined,
                  suggestedAction: j.suggested_action as string | undefined,
                  raw: { exit_code: code, ...j },
                },
              });
            }
          } catch {
            /* keep looking */
          }
        }
        resolve({ ok: false, error: { message: `swytchcode exec exited ${code}`, raw: { exit_code: code, stderr: err.slice(-2000) } } });
      });
      p.stdin.write(JSON.stringify({ tool: canonicalId, args: input }));
      p.stdin.end();
    });
  }
}
