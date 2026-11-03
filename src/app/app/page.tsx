import type { Metadata } from "next";
import Debugger from "@/web/Debugger";

export const metadata: Metadata = { title: "Debugger — swy-tm" };

export default async function AppPage({ searchParams }: { searchParams: Promise<{ run?: string; step?: string }> }) {
  const sp = await searchParams;
  const step = sp.step && /^\d+$/.test(sp.step) ? Number(sp.step) : undefined;
  return <Debugger initialRun={sp.run} initialStep={step} />;
}
