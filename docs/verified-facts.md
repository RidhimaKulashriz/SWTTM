# Verified facts (Swytchcode CLI 2.25.1, Linux amd64)

Everything here was run in this repo's sandbox. Full untrimmed output: [`raw-probe-output.log`](raw-probe-output.log).
Excerpt of the three Wrekenfile methods used: [`wrekenfile-excerpt.yaml`](wrekenfile-excerpt.yaml).

| # | Command | Trimmed real output | Conclusion |
|---|---|---|---|
| 1 | `curl -fsSL https://cli.swytchcode.com/install.sh \| sh` | `Checksum OK. Installed swytchcode to /usr/local/bin/swytchcode` | Installer works. Both `swytchcode` and its alias `swy` end up on PATH (`command -v swy swytchcode`). |
| 2 | `swytchcode --version` | `swytchcode version 2.25.1` | |
| 3 | `swytchcode init --editor=none --mode=sandbox --non-interactive` | `› initialized project at …` → creates `.swytchcode/tooling.json` (`{"editor":"none","integrations":{},"mode":"sandbox","tools":{},"version":"2.25.1"}`) | Spec's non-interactive init is correct. |
| 4 | `swytchcode get github` | `error: authentication required for get: not authenticated - run \`swytchcode login\` for registry features (local execution works without auth)` (exit 1) | `get` needs a Swytchcode login (device-flow OAuth). Not possible non-interactively here. |
| 5 | `swytchcode exec github.issues.create --json --dry-run` (a guessed id, not added) | `Fetching github… saved GitHub/github@1.1.4` then `running in demo mode (… not added yet)` (exit 2) | **`exec` auto-fetches the provider's `wrekenfile.yaml` without login.** That is how the GitHub bundle was obtained. |
| 6 | `swytchcode list methods issue` / `list --json` after #5 | empty methods; providers: `GitHub.github@1.1.4` | `methods.json` is only fetched after login, so `list`/`search` for method ids is empty offline. Method ids were read from the Wrekenfile instead (`grep` of `CANONICAL_ID`). |
| 7 | `swytchcode add method github.issue.create` (and `.labels.create`, `.update`) | `Added method "…" to tooling.json (provider: GitHub.github)` | `add method` works from the local Wrekenfile. IDs are real (not guessed): `github.issue.create`, `github.issue.labels.create`, `github.issue.update`. |
| 8 | `swytchcode info github.issue.create [--json]` | `Endpoint: POST /repos/{owner}/{repo}/issues`; inputs `owner` (path, STRING, required), `repo` (path), `body` (OBJECT, required; schema has `title`, `body`, `labels`, `assignees` …) | `info` shows the input contract. |
| 9 | `swytchcode exec github.issue.create --input owner=octo --input repo=demo --body '{"title":"hello"}' --dry-run --json` | log line: `request tool=github.issue.create {"body":{"title":"hello"},"owner":"octo","repo":"demo"}` | **Input shape is flat**: path params and `body` side by side. |
| 10 | `echo '{"tool":"github.issue.create","args":{"owner":…,"repo":…,"body":{…}}}' \| swytchcode exec --json` | same request log as #9 | **Stdin JSON form is `{"tool": <id>, "args": <flat args>}`** (matches `exec --help`). A `{"path":{…},"body":{…}}` shape is *not* unwrapped (it is passed through as a key named `path`). |
| 11 | #10 with `--dry-run`, no credentials | stderr (one JSON line): `{"error":"missing credentials for GitHub - run \`swytchcode auth connect GitHub\`","category":"auth","suggested_action":"…","docs_url":"https://docs.swytchcode.com/cli/authentication/","reference_id":"SWY-ERR-…"}`, exit 3, **stdout empty** | Errors go to **stderr** as classified JSON (`category`, `error`, `suggested_action`, `docs_url`, `reference_id`; `retryable` not seen in this error). `--dry-run` still checks credentials, so it is *not* a credential-free preview. |
| 12 | #10 without `--dry-run`, sandbox mode | `{"category":"base_url_not_set", … "set sandbox_endpoint for \"GitHub.github@1.1.4\" in .swytchcode/integrations/manifest.json, or set SWYTCHCODE_BASE_URL_GITHUB_GITHUB_SANDBOX"}` (exit 1) | In sandbox mode GitHub has an empty sandbox endpoint (production is `https://api.github.com`). |
| 13 | `GITHUB_TOKEN=x swytchcode exec …` | still `missing credentials for GitHub` | A `GITHUB_TOKEN` env var is **not** read. Credentials come from `swytchcode auth connect GitHub` (oauth2, per `manifest.json`: `"auth":{"type":"oauth2"}`). |
| 14 | `swytchcode audit --help`, `audit stats` | subcommands `network`, `policy`, `stats`, `clear`; data in `~/.swytchcode/audit/`; `stats` printed `Total runs: 10 … Last run: github.issue.create (failure …)` | `audit` exists and logs *executions* (what ran, success rate). It does not expose per-step state, so Time Machine keeps its own snapshots. |
| 15 | `swytchcode demo list`, `exec --demo stripe.payment.create` | `stripe.create_payment` is the only demo; other ids → `{"category":"network","error":"demo unavailable for …"}` (exit 4) | There is an offline-ish Stripe demo provider, but it was not needed. |

## What this means for the project

* **State carrier:** Time Machine reads nothing from Swytchcode's internal state; it records each `exec` result itself (`contextAfter` in every snapshot).
* **Real executor** (`src/executors/swytchcode.ts`) uses `swytchcode exec --json [--dry-run]` with `{"tool","args"}` on stdin and parses the stderr error line. Verified end to end: `swy-tm run workflows/github-issue.workflow.json --executor swytchcode --dry-run` records a real classified `auth` error as an `error` snapshot.
* **Real GitHub execution is blocked** in this sandbox: it needs `swytchcode auth connect GitHub` (interactive OAuth) and a sandbox endpoint. No real GitHub issue was created by this project. The `github-issue` workflow is therefore only exercised as a dry-run that stops at step 0 with the auth error.
