// TEST ONLY. Preload (NODE_OPTIONS=--require) that answers api.github.com calls made with a token starting "fake" from memory,
// so the browser e2e can drive the real UI and API without touching a real repository. Never used in production.
const issues = new Map(); let next = 1, cid = 500; const log = [];
const real = globalThis.fetch;
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999" } });
const view = (i) => ({ number: i.number, id: 1000 + i.number, title: i.title, state: i.state, comments: i.comments.length, html_url: `https://github.com/demo/repo/issues/${i.number}`, updated_at: new Date().toISOString(), labels: i.labels.map((name) => ({ name })) });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
  if (url.hostname === "api.github.com" && /^Bearer fake/.test(new Headers(init.headers).get("authorization") || "")) {
    const m_ = init.method || "GET", p = url.pathname, body = init.body ? JSON.parse(init.body) : {};
    if (m_ !== "GET") log.push(`${m_} ${p}`);
    if (p === "/__log") return json(log);
    if (p === "/user") return json({ id: 7, login: "demo-user", name: "Demo", avatar_url: "" });
    if (p === "/repos/demo/repo") return json({ full_name: "demo/repo", html_url: "https://github.com/demo/repo", private: false, has_issues: true, open_issues_count: issues.size, default_branch: "main", permissions: { push: true } });
    let m;
    if (p === "/repos/demo/repo/issues" && m_ === "POST") { const i = { number: next++, title: body.title, state: "open", labels: [], comments: [] }; issues.set(i.number, i); return json(view(i), 201); }
    if ((m = /^\/repos\/demo\/repo\/issues\/(\d+)\/labels$/.exec(p)) && m_ === "POST") { const i = issues.get(+m[1]); if (!i) return json({ message: "Not Found" }, 404); for (const l of body.labels) if (!i.labels.includes(l)) i.labels.push(l); return json(i.labels.map((name) => ({ name }))); }
    if ((m = /^\/repos\/demo\/repo\/issues\/(\d+)\/labels\/(.+)$/.exec(p)) && m_ === "DELETE") { const i = issues.get(+m[1]); i.labels = i.labels.filter((l) => l !== decodeURIComponent(m[2])); return json(i.labels.map((name) => ({ name }))); }
    if ((m = /^\/repos\/demo\/repo\/issues\/(\d+)\/comments$/.exec(p))) { const i = issues.get(+m[1]); if (!i) return json({ message: "Not Found" }, 404); if (m_ === "GET") return json(i.comments); const c = { id: cid++, body: body.body }; i.comments.push(c); return json({ ...c, html_url: `https://github.com/demo/repo/issues/${i.number}#c${c.id}` }, 201); }
    if ((m = /^\/repos\/demo\/repo\/issues\/comments\/(\d+)$/.exec(p)) && m_ === "DELETE") { for (const i of issues.values()) i.comments = i.comments.filter((c) => c.id !== +m[1]); return new Response(null, { status: 204 }); }
    if ((m = /^\/repos\/demo\/repo\/issues\/(\d+)$/.exec(p))) { const i = issues.get(+m[1]); if (!i) return json({ message: "Not Found" }, 404); if (m_ === "PATCH") { if (body.state !== "open" && body.state !== "closed") return json({ message: "Validation Failed" }, 422); i.state = body.state; } return json(view(i)); }
    return json({ message: "Not Found" }, 404);
  }
  return real(input, init);
};
