"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffResult } from "../core/diff";
import { diffToMarkdown, fmtValue } from "../core/report";

/* ------------------------------------------------------------------ */
/* TimelineScrubber: horizontal bar with draggable playhead            */
/* ------------------------------------------------------------------ */
export function TimelineScrubber({
  steps,
  value,
  onChange,
  onCommit,
}: {
  steps: { id: string; status: string }[];
  value: number; // fractional step index
  onChange?: (v: number) => void;
  onCommit: (i: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const max = Math.max(steps.length - 1, 1);
  const calc = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.min(max, Math.max(0, ((e.clientX - r.left) / r.width) * max));
  };
  return (
    <div
      ref={ref}
      className="scrub"
      role="slider"
      tabIndex={0}
      aria-label="Timeline playhead"
      aria-valuemin={0}
      aria-valuemax={steps.length - 1}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`Step ${Math.round(value) + 1}: ${steps[Math.round(value)]?.id ?? ""}`}
      onPointerDown={(e) => {
        dragging.current = true;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onChange?.(calc(e));
      }}
      onPointerMove={(e) => dragging.current && onChange?.(calc(e))}
      onPointerUp={(e) => {
        dragging.current = false;
        onCommit(Math.round(calc(e)));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onCommit(Math.min(max, Math.round(value) + 1));
        if (e.key === "ArrowLeft") onCommit(Math.max(0, Math.round(value) - 1));
      }}
    >
      {steps.map((s, i) => (
        <b key={s.id} style={{ left: `${(i / max) * 100}%`, background: s.status === "error" ? "var(--alert)" : s.status === "injected" ? "#555" : "var(--ok)" }} />
      ))}
      <i style={{ left: `${(value / max) * 100}%` }} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* JsonView: collapsible, searchable                                    */
/* ------------------------------------------------------------------ */
export function JsonView({ value, query = "", depth = 0 }: { value: unknown; query?: string; depth?: number }) {
  const hl = (text: string) => {
    if (!query) return text;
    const i = text.toLowerCase().indexOf(query.toLowerCase());
    return i < 0 ? text : (
      <>
        {text.slice(0, i)}
        <mark>{text.slice(i, i + query.length)}</mark>
        {text.slice(i + query.length)}
      </>
    );
  };
  if (value === null || typeof value !== "object") {
    if (value === undefined) return <span className="label">(absent)</span>;
    const cls = typeof value === "string" ? "s" : "n";
    return <span className={cls}>{hl(JSON.stringify(value))}</span>;
  }
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  const [open, br] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return <span>{open + br}</span>;
  return (
    <details open={depth < 2 || !!query}>
      <summary>
        {open} <span className="label">{entries.length} {entries.length === 1 ? "item" : "items"}</span>
      </summary>
      {entries.map(([k, v]) => (
        <div key={k} style={{ marginLeft: 14 }}>
          <span className="k">{hl(k)}</span>: <JsonView value={v} query={query} depth={depth + 1} />
        </div>
      ))}
      <div>{br}</div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* DiffView                                                             */
/* ------------------------------------------------------------------ */
export function DiffView({ diff, onJump }: { diff: DiffResult; onJump?: (i: number) => void }) {
  const [filters, setFilters] = useState<Record<string, boolean>>({ changed: true, added: true, removed: true });
  const [showVol, setShowVol] = useState(false);
  const [copied, setCopied] = useState(false);
  const toggle = (k: string) => setFilters((f) => ({ ...f, [k]: !f[k] }));
  const identical = diff.steps.filter((s) => s.state === "identical");
  const copy = useCallback(async () => {
    await navigator.clipboard?.writeText(diffToMarkdown(diff)).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [diff]);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
        <span className="label">Divergence {diff.a} → {diff.b}</span>
        {(["changed", "added", "removed"] as const).map((k) => (
          <button key={k} className="chipf" aria-pressed={filters[k]} onClick={() => toggle(k)}>
            {k}
          </button>
        ))}
        <button className="chipf" onClick={copy}>{copied ? "copied ✓" : "copy as markdown"}</button>
        {diff.firstDivergence !== null && (
          <button className="chipf" onClick={() => onJump?.(diff.firstDivergence!)}>jump to first divergence (step {diff.firstDivergence})</button>
        )}
      </div>
      {identical.length > 0 && (
        <div className="label" style={{ marginBottom: 6 }}>
          {identical.length} unchanged step{identical.length > 1 ? "s" : ""} collapsed: {identical.map((s) => `${s.index}:${s.stepId}${s.injectedB ? " (injected)" : ""}`).join(" · ")}
        </div>
      )}
      {diff.steps
        .filter((s) => s.state !== "identical")
        .map((s) => (
          <div key={s.index} style={{ marginBottom: 10 }}>
            <div className="mono red">
              step {s.index} {s.stepId} · DIVERGED{s.statusA !== s.statusB ? ` · status: ${s.statusA} → ${s.statusB}` : ""}
            </div>
            <table className="difflist">
              <tbody>
                {s.changes
                  .filter((c) => !c.volatile && filters[c.kind])
                  .map((c) => (
                    <tr key={c.path}>
                      <td className="label">{c.path}</td>
                      <td style={{ color: "var(--alert)" }}>{fmtValue(c.before)}</td>
                      <td>→</td>
                      <td style={{ color: "var(--ok)" }}>{fmtValue(c.after)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ))}
      <button className="chipf" aria-expanded={showVol} onClick={() => setShowVol((v) => !v)}>
        volatile fields ignored: {diff.volatile.length}
      </button>
      {showVol && (
        <ul className="label" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {diff.volatile.map((v, i) => (
            <li key={i}>
              {v.path}: {fmtValue(v.before)} → {fmtValue(v.after)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* TerminalPlayer: replays a captured transcript                        */
/* ------------------------------------------------------------------ */
export function TerminalPlayer({ lines, title }: { lines: string[]; title: string }) {
  const [shown, setShown] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const paused = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const reduce = useMemo(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches, []);

  useEffect(() => {
    if (reduce) {
      queueMicrotask(() => setShown(lines));
      return;
    }
    let cancelled = false;
    const wait = (ms: number) =>
      new Promise<void>((r) => {
        const t = setTimeout(r, ms);
        if (cancelled) clearTimeout(t);
      });
    (async () => {
      while (!cancelled) {
        setShown([]);
        for (const line of lines) {
          if (cancelled) return;
          while (paused.current && !cancelled) await wait(100);
          if (line.startsWith("$ ")) {
            setShown((s) => [...s, ""]);
            for (let c = 1; c <= line.length; c++) {
              if (cancelled) return;
              setShown((s) => [...s.slice(0, -1), line.slice(0, c)]);
              await wait(1000 / 45);
            }
            await wait(250);
          } else {
            setShown((s) => [...s, line]);
            await wait(60);
          }
        }
        await wait(3500);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lines, reduce]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  return (
    <div
      className="frame"
      onMouseEnter={() => (paused.current = true)}
      onMouseLeave={() => (paused.current = false)}
      onFocus={() => (paused.current = true)}
      onBlur={() => (paused.current = false)}
    >
      <div className="term" ref={box} tabIndex={0} role="log" aria-label="Recorded swy-tm demo transcript">
        <div className="bar label">
          <span>{title}</span>
          <button
            className="chipf"
            onClick={async () => {
              await navigator.clipboard?.writeText(lines.join("\n")).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1400);
            }}
          >
            {copied ? "copied ✓" : "copy"}
          </button>
        </div>
        {shown.map((l, i) => (
          <div key={i} style={{ color: l.startsWith("$") ? "var(--ok)" : l.includes("failed") || l.includes("error") ? "#ff7a70" : undefined }}>
            {l || "\u00a0"}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* original SVG art                                                     */
/* ------------------------------------------------------------------ */
export function ClockGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M9 5.5V9l2.5 1.6" />
      <path d="M13.5 13.5 17 17M17 17h4M17 17v4" />
    </svg>
  );
}

export function Panel({ title, lines, accent = false, w = 360, h = 220 }: { title: string; lines: string[]; accent?: boolean; w?: number; h?: number }) {
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={title} style={{ maxWidth: w, overflow: "visible" }}>
      <rect x="1" y="1" width={w - 2} height={h - 2} rx="10" fill="#0a0a0a" stroke={accent ? "#ff2a1a" : "rgba(243,242,238,.5)"} />
      <path d={`M1 34H${w - 1}`} stroke="rgba(243,242,238,.25)" />
      <circle cx="18" cy="18" r="4" fill={accent ? "#ff2a1a" : "none"} stroke="rgba(243,242,238,.6)" />
      <text x="34" y="22" fill="#f3f2ee" fontFamily="var(--font-mono)" fontSize="11" letterSpacing="1">
        {title.toUpperCase()}
      </text>
      {lines.map((l, i) => (
        <text key={i} x="18" y={58 + i * 20} fill={i % 3 === 1 ? "#8ab4ff" : "rgba(243,242,238,.7)"} fontFamily="var(--font-mono)" fontSize="11">
          {l}
        </text>
      ))}
    </svg>
  );
}

export function StageArt({ stage }: { stage: number }) {
  const s = { stroke: "rgba(243,242,238,.55)", fill: "none" } as const;
  const red = { stroke: "#ff2a1a", fill: "none" } as const;
  return (
    <svg viewBox="0 0 560 360" width="100%" role="img" aria-label={["Timeline of hashed snapshots", "JSON inspector panel", "Branching timeline", "Split diff"][stage]} style={{ maxWidth: 640 }}>
      <rect x="1" y="1" width="558" height="358" rx="12" {...s} strokeDasharray="2 6" />
      {stage === 0 && (
        <g>
          <path d="M40 180H520" {...s} />
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x={60 + i * 160} y="140" width="120" height="80" rx="10" {...(i === 2 ? red : s)} />
              <text x={72 + i * 160} y="172" fill="#f3f2ee" fontFamily="var(--font-mono)" fontSize="11">0{i + 1}</text>
              <text x={72 + i * 160} y="206" fill="rgba(243,242,238,.6)" fontFamily="var(--font-mono)" fontSize="10">#{["d915a42a", "d7b5d632", "fff0e74a"][i]}</text>
            </g>
          ))}
        </g>
      )}
      {stage === 1 && (
        <g fontFamily="var(--font-mono)" fontSize="12">
          <rect x="60" y="50" width="440" height="260" rx="8" {...s} />
          {["{", '  "status": "ok",', '  "resolvedInput": { "path": { "id": 1 } },', '  "output": { "labels": ["bug"] },', '  "sideEffect": true,', '  "hash": "d7b5d632…"', "}"].map((l, i) => (
            <text key={i} x="80" y={90 + i * 32} fill={i === 5 ? "#ff2a1a" : "#f3f2ee"}>{l}</text>
          ))}
        </g>
      )}
      {stage === 2 && (
        <g>
          <path d="M40 200H200" {...s} />
          <path d="M200 200C260 200 260 110 320 110H520" {...s} />
          <path d="M200 200C260 200 260 290 320 290H520" {...red} strokeDasharray="6 5" />
          {[80, 200, 330, 450].map((x) => <circle key={x} cx={x} cy={x === 330 || x === 450 ? 110 : 200} r="9" {...s} />)}
          <text x="330" y="84" fill="#f3f2ee" fontFamily="var(--font-mono)" fontSize="11">REPLAY (tail only)</text>
          <text x="330" y="322" fill="#ff2a1a" fontFamily="var(--font-mono)" fontSize="11">ORIGINAL (failed)</text>
        </g>
      )}
      {stage === 3 && (
        <g fontFamily="var(--font-mono)" fontSize="12">
          <path d="M280 40V320" {...s} />
          <text x="40" y="70" fill="rgba(243,242,238,.6)">before</text>
          <text x="300" y="70" fill="rgba(243,242,238,.6)">after</text>
          <rect x="30" y="120" width="230" height="30" fill="rgba(255,42,26,.18)" />
          <rect x="300" y="120" width="230" height="30" fill="rgba(61,255,154,.16)" />
          <text x="40" y="141" fill="#ff7a70">state: &quot;done&quot;</text>
          <text x="310" y="141" fill="#3dff9a">state: &quot;closed&quot;</text>
          <text x="40" y="200" fill="rgba(243,242,238,.5)">status: error</text>
          <text x="310" y="200" fill="rgba(243,242,238,.8)">status: ok</text>
        </g>
      )}
    </svg>
  );
}
