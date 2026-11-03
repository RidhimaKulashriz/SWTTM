"use client";
import { useState } from "react";
import type { ConnInfo } from "./connection";

export type Launch = {
  workflow: string;
  title: string;
  label: string;
  comment: string;
  finalState: "open" | "closed";
  breakLast: boolean;
  dryRun: boolean;
};

export const WORKFLOWS: { id: string; name: string; steps: string }[] = [
  { id: "github-issue", name: "Issue lifecycle", steps: "create issue → add label → set state" },
  { id: "github-triage", name: "Triage with comment", steps: "create issue → add label → post comment → set state" },
];

export function ConnectForm({ onConnect, busy, error }: { onConnect: (token: string, repo: string, remember: boolean) => void; busy: boolean; error: string }) {
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [remember, setRemember] = useState(false);
  const ready = token.trim().length >= 20 && /^[\w.-]+\/[\w.-]+$/.test(repo.trim());
  return (
    <form
      className="dock-grid"
      aria-label="Connect GitHub"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onConnect(token.trim(), repo.trim(), remember);
      }}
    >
      <div className="dock-intro">
        <div className="label">1 · CONNECT YOUR GITHUB</div>
        <h2 className="dock-title">Debug real GitHub workflows on your own repository.</h2>
        <p className="dock-copy">
          Every step runs against the real GitHub API with <b>your</b> token, in <b>your</b> repo. Runs are saved to your account only — nobody else can see or replay
          them. Your token stays in this browser tab and is never stored on the server.
        </p>
        <ol className="dock-steps">
          <li>
            Create a{" "}
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer noopener">fine-grained token</a>{" "}
            limited to one repository, with <b>Issues → Read and write</b>.
          </li>
          <li>Paste it below with the repository (owner/name) and press Connect.</li>
          <li>Run a workflow, break a step on purpose, then fix and replay from that step.</li>
        </ol>
      </div>
      <div className="dock-form">
        <label>
          <span className="label">GitHub token</span>
          <input type="password" autoComplete="off" spellCheck={false} aria-label="GitHub token" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <label>
          <span className="label">Repository</span>
          <input type="text" autoComplete="off" spellCheck={false} aria-label="Repository (owner/name)" placeholder="your-name/your-repo" value={repo} onChange={(e) => setRepo(e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember on this device (otherwise it is forgotten when the tab closes)
        </label>
        <button className="btn" type="submit" disabled={!ready || busy}>{busy ? "Checking with GitHub…" : "Connect"}</button>
        {error && <p className="warn" role="alert">{error}</p>}
      </div>
    </form>
  );
}

export function Launcher({
  info,
  launch,
  setLaunch,
  onRun,
  onDisconnect,
  busy,
}: {
  info: ConnInfo;
  launch: Launch;
  setLaunch: (l: Launch) => void;
  onRun: () => void;
  onDisconnect: () => void;
  busy: boolean;
}) {
  const wf = WORKFLOWS.find((w) => w.id === launch.workflow) ?? WORKFLOWS[0];
  const set = <K extends keyof Launch>(k: K, v: Launch[K]) => setLaunch({ ...launch, [k]: v });
  const valid = launch.title.trim() && launch.label.trim() && (launch.workflow !== "github-triage" || launch.comment.trim());
  return (
    <div className="dock-grid">
      <div className="dock-intro">
        <div className="label">CONNECTED · LIVE</div>
        <div className="who">
          {info.avatarUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={info.avatarUrl} alt="" width={36} height={36} />
          )}
          <div>
            <div className="mono">@{info.login}</div>
            <a className="mono" href={info.repositoryUrl} target="_blank" rel="noreferrer noopener">{info.repository} ↗</a>
          </div>
        </div>
        <div className="label" style={{ margin: "8px 0" }}>
          {info.private ? "private" : "public"} repo · {info.openIssues} open issues · {info.canWriteIssues === false ? "read-only token" : "can write issues"}
        </div>
        <button className="btn sm ghost" onClick={onDisconnect}>Disconnect</button>
      </div>
      <div className="dock-form">
        <div className="label">2 · RUN A REAL WORKFLOW</div>
        <div className="row">
          <label style={{ flex: "1 1 200px" }}>
            <span className="label">Workflow</span>
            <select aria-label="Workflow" value={launch.workflow} onChange={(e) => set("workflow", e.target.value)}>
              {WORKFLOWS.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </label>
          <label style={{ flex: "2 1 240px" }}>
            <span className="label">Issue title</span>
            <input type="text" aria-label="Issue title" value={launch.title} onChange={(e) => set("title", e.target.value)} />
          </label>
        </div>
        <div className="label">{wf.steps}</div>
        <div className="row">
          <label style={{ flex: "1 1 120px" }}>
            <span className="label">Label</span>
            <input type="text" aria-label="Issue label" value={launch.label} onChange={(e) => set("label", e.target.value)} />
          </label>
          {launch.workflow === "github-triage" && (
            <label style={{ flex: "2 1 200px" }}>
              <span className="label">Comment</span>
              <input type="text" aria-label="Issue comment" value={launch.comment} onChange={(e) => set("comment", e.target.value)} />
            </label>
          )}
          <label>
            <span className="label">Final state</span>
            <select aria-label="Final state" value={launch.finalState} onChange={(e) => set("finalState", e.target.value as "open" | "closed")}>
              <option value="closed">closed</option>
              <option value="open">open</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ alignItems: "center" }}>
          <label className="check">
            <input type="checkbox" checked={launch.breakLast} onChange={(e) => set("breakLast", e.target.checked)} /> Break the last step on purpose (so you can practise fix &amp; replay)
          </label>
          <label className="check">
            <input type="checkbox" checked={launch.dryRun} onChange={(e) => set("dryRun", e.target.checked)} /> Plan only (no GitHub changes)
          </label>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || !valid} onClick={onRun}>{busy ? "Running…" : launch.dryRun ? "Preview plan" : "Run on GitHub"}</button>
        </div>
      </div>
    </div>
  );
}
