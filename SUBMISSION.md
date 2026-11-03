# Submission pack (copy-paste)

## (a) What Swytchcode is, in my own words (verified, ~190 words)
Swytchcode is a CLI (`swytchcode`, alias `swy`) that sits between an agent and third-party APIs. A project is initialised with `swytchcode init`; an API provider's description — a Wrekenfile listing every method with a canonical id like `github.issue.create`, its HTTP endpoint and typed inputs — is fetched into `.swytchcode/integrations/`. You explicitly enable the methods you trust with `swytchcode add method <id>`, which records them in `tooling.json`; that is the trust boundary. `swytchcode info <id>` shows a method's input contract, and `swytchcode exec <id>` runs it (arguments as flags or `{"tool","args"}` JSON on stdin, `--json` for machine output, `--dry-run` to preview). Failures come back as a classified JSON error (`category`, `suggested_action`, `docs_url`) with distinct exit codes, and `swytchcode audit` keeps a local log of executions. Credentials are managed by Swytchcode (`swytchcode auth connect`) rather than read from env vars.
Practical example: to file a bug, enable `github.issue.create`, then run `echo '{"tool":"github.issue.create","args":{"owner":"o","repo":"r","body":{"title":"Checkout crashes"}}}' | swytchcode exec --json`. Without a connected account I got `missing credentials for GitHub` (category `auth`).

## (b) LinkedIn post (≤180 words)
Agent workflows rarely fail at step 1. They fail at step 3, after steps 1 and 2 already did real things.

I built swy-tm, a small prototype "time machine" on top of the Swytchcode CLI: it snapshots every step (hash-chained), lets you inspect the exact input/output of any step, and replays only the failed tail with one changed input — earlier steps are injected from their recorded outputs, not re-run. A side-effect guard refuses to repeat steps that already changed something unless you pass --compensate or --allow-duplicate, and a divergence report shows exactly what changed.

Honest status: it's a prototype for an onboarding assignment. The demo runs on a mock tracker (labelled MOCK everywhere); I could not execute real GitHub calls because Swytchcode auth is interactive OAuth, so the real path is only a recorded dry-run. Everything is in the repo with a friction diary of what went wrong along the way.

Repo: https://github.com/RidhimaKulashriz/switchtm · Demo: https://switchtm-eight.vercel.app/
#agents #devtools #swytchcode

## (c) Demo script (≈2:40)
| Time | Say | Command |
|---|---|---|
| 0:00 | Problem: step 3 fails after steps 1–2 had effects | — |
| 0:15 | One command shows the whole story (MOCK) | `./bin/swy-tm demo` |
| 0:45 | Inspect what step 1 left behind | `./bin/swy-tm inspect <run> --step 1` |
| 1:05 | Replay only the tail with a fixed input | `./bin/swy-tm replay <run> --from-step 2 --set inputs.finalState=closed` (point at `executor calls: 1 (injected: 2)`) |
| 1:30 | Guard: replay from 0 aborts, exit 3 | `./bin/swy-tm replay <run> --from-step 0` |
| 1:45 | Diff + verify | `./bin/swy-tm diff <run> <replay>` · `./bin/swy-tm verify <replay>` |
| 2:00 | Real Swytchcode path (dry-run, auth error recorded) | `./bin/swy-tm run workflows/github-issue.workflow.json --executor swytchcode --dry-run --set inputs.owner=octocat --set inputs.repo=hello-world` |
| 2:20 | UI | `./bin/swy-tm serve --open` → `/app` → Run workflow → Replay |
| 2:40 | Limits: mock only, no real GitHub | — |

## (d) AI-usage disclosure
Built with AI assistance (code, tests, UI and documentation); the Swytchcode CLI probes were run during the build (outputs in `docs/verified-facts.md`). REA was not used. Nothing was hand-edited by a human yet; the human must review, record the video and submit.

## (e) Repo link
https://github.com/RidhimaKulashriz/switchtm

Live app: https://switchtm-eight.vercel.app/

## (f) Onboarding answers (from FRICTION.md)
- Easiest: install script, `init --non-interactive`, `add method`, `info` — all worked offline from the Wrekenfile.
- Hardest: `swytchcode get` needs interactive login; `--dry-run` still needs credentials; GitHub auth is OAuth only (a `GITHUB_TOKEN` env var is ignored); error JSON is on stderr mixed with log/telemetry noise.
- Surprise: `exec` with a mistyped id silently downloads the provider bundle and falls into "demo mode".
- Docs I wished for: a non-interactive credential option for CI and a documented input shape for `exec` stdin.

## (g) Publish
```bash
git add -A && git commit -m "swy-tm prototype"
gh auth status && gh repo create swytchcode-time-machine --public --source=. --push
```
(I did not push anything; `gh` was not used.)
