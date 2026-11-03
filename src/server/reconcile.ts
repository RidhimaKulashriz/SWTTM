import type { Snapshot } from "../core/types";
import { GITHUB_API, GITHUB_TIMEOUT_MS } from "../executors/github";

export type IssueCheck = {
  number: number;
  url: string;
  title: string | null;
  status: "in_sync" | "drift" | "missing" | "error";
  recorded: { state: string | null; labels: string[]; comments: number };
  live: { state: string; labels: string[]; comments: number; title: string } | null;
  notes: string[];
};

export type ReconcileReport = {
  repository: string;
  checkedAt: string;
  issues: IssueCheck[];
  summary: { inSync: number; drift: number; missing: number; error: number };
  truncated: boolean;
};

type Recorded = { number: number; title: string | null; state: string | null; labels: Set<string>; comments: Set<number> };
const MAX_ISSUES = 10;

const isDry = (o: unknown) => Boolean(o && typeof o === "object" && (o as { dryRun?: unknown }).dryRun === true);
const num = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);
const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Fold a run's recorded real side effects (in the order they happened) into the state GitHub should now be in. */
export function recordedState(snapshots: Snapshot[], owner: string, repo: string): Recorded[] {
  const issues = new Map<number, Recorded>();
  const get = (n: number) => {
    let r = issues.get(n);
    if (!r) issues.set(n, (r = { number: n, title: null, state: null, labels: new Set(), comments: new Set() }));
    return r;
  };
  for (const s of [...snapshots].sort((a, b) => a.seq - b.seq)) {
    if ((s.status !== "ok" && s.status !== "injected") || !s.canonicalId.startsWith("github.") || isDry(s.output)) continue;
    const input = (s.resolvedInput ?? {}) as { owner?: unknown; repo?: unknown };
    if (String(input.owner).toLowerCase() !== owner.toLowerCase() || String(input.repo).toLowerCase() !== repo.toLowerCase()) continue;
    const out = (s.output ?? {}) as Record<string, unknown>;
    const n = num(out.number);
    switch (s.canonicalId) {
      case "github.issue.create":
        if (n) Object.assign(get(n), { title: typeof out.title === "string" ? out.title : null, state: typeof out.state === "string" ? out.state : "open", labels: new Set(names(out.labels)) });
        break;
      case "github.issue.update":
        if (n) {
          const r = get(n);
          if (typeof out.state === "string") r.state = out.state;
          if (Array.isArray(out.labels)) r.labels = new Set(names(out.labels));
        }
        break;
      case "github.issue.labels.create":
      case "github.issue.labels.remove":
        if (n) get(n).labels = new Set(names(out.labels));
        break;
      case "github.issue.comment.create":
        if (n && num(out.id)) get(n).comments.add(out.id as number);
        break;
      case "github.issue.comment.delete":
        for (const r of issues.values()) r.comments.delete(Number(out.id));
        break;
    }
  }
  return [...issues.values()];
}

async function call(path: string, token: string, fetcher: typeof fetch) {
  return fetcher(`${GITHUB_API}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "swy-tm-debugger",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.some((y) => y.toLowerCase() === x.toLowerCase()));

/** Ask GitHub what is really there and compare it with what the snapshots say happened. */
export async function reconcile(
  snapshots: Snapshot[],
  creds: { token: string; owner: string; repo: string },
  fetcher: typeof fetch = fetch,
): Promise<ReconcileReport> {
  const all = recordedState(snapshots, creds.owner, creds.repo);
  const picked = all.slice(0, MAX_ISSUES);
  const base = `/repos/${encodeURIComponent(creds.owner)}/${encodeURIComponent(creds.repo)}/issues`;

  const issues = await Promise.all(
    picked.map(async (rec): Promise<IssueCheck> => {
      const url = `https://github.com/${creds.owner}/${creds.repo}/issues/${rec.number}`;
      const recorded = { state: rec.state, labels: [...rec.labels], comments: rec.comments.size };
      try {
        const res = await call(`${base}/${rec.number}`, creds.token, fetcher);
        if (res.status === 404 || res.status === 410) {
          return { number: rec.number, url, title: rec.title, status: "missing", recorded, live: null, notes: ["The issue no longer exists on GitHub (deleted or transferred)."] };
        }
        if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}`);
        const issue = (await res.json()) as { state: string; title: string; html_url?: string; labels?: Array<{ name?: string } | string>; comments?: number };
        const liveLabels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean);
        const notes: string[] = [];
        if (rec.state && issue.state !== rec.state) notes.push(`State is "${issue.state}" on GitHub but the snapshots recorded "${rec.state}".`);
        if (!sameSet(recorded.labels, liveLabels)) notes.push(`Labels on GitHub are [${liveLabels.join(", ")}], recorded [${recorded.labels.join(", ")}].`);
        let liveComments = issue.comments ?? 0;
        if (rec.comments.size) {
          const cr = await call(`${base}/${rec.number}/comments?per_page=100`, creds.token, fetcher);
          if (cr.ok) {
            const list = (await cr.json()) as Array<{ id: number }>;
            liveComments = list.length;
            const missing = [...rec.comments].filter((id) => !list.some((c) => c.id === id));
            if (missing.length) notes.push(`${missing.length} recorded comment(s) are no longer on the issue.`);
          }
        }
        return {
          number: rec.number,
          url: issue.html_url ?? url,
          title: issue.title,
          status: notes.length ? "drift" : "in_sync",
          recorded,
          live: { state: issue.state, labels: liveLabels, comments: liveComments, title: issue.title },
          notes,
        };
      } catch (e) {
        return { number: rec.number, url, title: rec.title, status: "error", recorded, live: null, notes: [(e as Error).message || "Could not reach GitHub."] };
      }
    }),
  );

  const count = (s: IssueCheck["status"]) => issues.filter((i) => i.status === s).length;
  return {
    repository: `${creds.owner}/${creds.repo}`,
    checkedAt: new Date().toISOString(),
    issues,
    summary: { inSync: count("in_sync"), drift: count("drift"), missing: count("missing"), error: count("error") },
    truncated: all.length > picked.length,
  };
}
