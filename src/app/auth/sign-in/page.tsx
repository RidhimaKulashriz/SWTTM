"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";

export default function SignInPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      const result = mode === "sign-in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: name || email.split("@")[0] });
      if (result.error) {
        setMessage(result.error.message || "Authentication failed.");
      } else {
        router.replace("/app");
        router.refresh();
      }
    } catch {
      setMessage("Neon Auth could not be reached. Check the deployment's Neon Auth settings and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 480, margin: "10vh auto", padding: 24 }}>
      <Link href="/app" className="mono">← debugger</Link>
      <h1 style={{ marginTop: 28 }}>{mode === "sign-in" ? "Sign in for live GitHub runs" : "Create an account"}</h1>
      <p className="label">Live GitHub execution and saved snapshots are restricted to the email configured by the repository owner.</p>
      <form onSubmit={submit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
        {mode === "sign-up" && (
          <label>Name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        )}
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {message && <p role="alert">{message}</p>}
        <button className="btn" type="submit" disabled={busy}>{busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}</button>
      </form>
      <button className="btn ghost" style={{ marginTop: 12 }} type="button" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setMessage(""); }}>
        {mode === "sign-in" ? "Create account" : "Back to sign in"}
      </button>
    </main>
  );
}
