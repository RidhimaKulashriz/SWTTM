# Decisions

`date · decision · why`

- 2026-11-02 · Web UI + API implemented inside the provided **Next.js (App Router)** project instead of Vite + Fastify · the workspace is a Next.js template with a mandated build/health-check pipeline; one runtime is simpler to run and verify. API routes implement the §9 endpoints.
- 2026-11-02 · `swy-tm serve` spawns `next start -H 127.0.0.1 -p 4173` (falls back to `next dev` when there is no build) · keeps the "loopback only" rule without a second server.
- 2026-11-02 · No `npm run demo/test/verify` scripts · `package.json` may not be edited directly in this workspace. Use `./bin/swy-tm`, `npx tsx src/cli/index.ts`, `npx vitest run`, `npx playwright test`.
- 2026-11-02 · CLI is a single `src/cli/index.ts` + `format.ts` rather than `commands/*.ts` · fewer files for the same behavior.
- 2026-11-02 · Added `compensate` to the demo workflow's `label` step (`tracker.issue.unlabel`) · otherwise a from-step-0 replay with `--compensate` aborts with exit 3 (guarded `label` step has no compensation), and the §12 ledger expectation (`created:2, deleted:1`) could not hold.
- 2026-11-02 · Snapshots carry an extra `seq` field and the manifest carries `workflow` + `inputs` · compensation snapshots need a position in the hash chain; replay needs the workflow definition even if the file changes later.
- 2026-11-02 · `injected` snapshots count as "already applied" for the side-effect guard · a replay-of-a-replay would otherwise silently duplicate effects from the first run.
- 2026-11-02 · Volatile-field rule: key suffix `created|updated|timestamp|time|at`, `x-request-id`, `--ignore` globs, and "both values are ISO timestamps" · simpler than the spec's "key changed on every step" heuristic. Counted and listed, never hidden.
- 2026-11-02 · SSE uses a client-chosen `streamId` (open `EventSource` first, then POST with the same id) · the run id does not exist before the run starts. In-memory bus, single process only.
- 2026-11-02 · Real GitHub workflow is exercised only as `--dry-run` · auth is interactive OAuth (`swytchcode auth connect`), see FRICTION.md.
- 2026-11-02 · Text-only logos, original SVGs, `@fontsource` fonts (Anton / Inter Tight / JetBrains Mono) · originality rules and no runtime font requests.
- 2026-11-02 · `data-reveal="lines"` is implemented as a per-block mask (no line measuring) · avoids layout-dependent splitting; `words`/`chars` are real splits.
