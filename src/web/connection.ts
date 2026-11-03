/**
 * The visitor's own GitHub connection. The token lives only in this browser (sessionStorage by default,
 * localStorage if they tick "remember"), and is sent as a header on each API call. The server never stores it.
 */
export type Conn = { token: string; repo: string };
export type ConnInfo = {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  repository: string;
  repositoryUrl: string;
  private: boolean;
  defaultBranch: string | null;
  openIssues: number;
  canWriteIssues: boolean | null;
};

const KEY = "swytm.connection";
let current: Conn | null = null;

export function getConn(): Conn | null {
  return current;
}

export function loadStoredConn(): { conn: Conn; remembered: boolean } | null {
  try {
    for (const [store, remembered] of [[window.sessionStorage, false], [window.localStorage, true]] as const) {
      const raw = store.getItem(KEY);
      if (!raw) continue;
      const c = JSON.parse(raw) as Partial<Conn>;
      if (typeof c.token === "string" && typeof c.repo === "string") return { conn: { token: c.token, repo: c.repo }, remembered };
    }
  } catch {
    /* storage unavailable */
  }
  return null;
}

export function setConn(conn: Conn | null, remember = false) {
  current = conn;
  try {
    window.sessionStorage.removeItem(KEY);
    window.localStorage.removeItem(KEY);
    if (conn) (remember ? window.localStorage : window.sessionStorage).setItem(KEY, JSON.stringify(conn));
  } catch {
    /* storage unavailable: the connection still works for this page view */
  }
}

export function authHeaders(): Record<string, string> {
  return current ? { "x-gh-token": current.token, "x-gh-repo": current.repo } : {};
}

export async function api<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T }> {
  const r = await fetch(url, { cache: "no-store", ...init, headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) } });
  const body = (await r.json().catch(() => ({}))) as T;
  return { ok: r.ok, status: r.status, body };
}
