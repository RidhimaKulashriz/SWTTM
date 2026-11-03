import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource/anton/400.css";
import "@fontsource/inter-tight/400.css";
import "@fontsource/inter-tight/500.css";
import "@fontsource/inter-tight/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "swy-tm — A time machine for agent workflows",
  description:
    "Independent prototype: record a snapshot after every step of a Swytchcode workflow, rewind a failed run, change one input and replay only the tail.",
};
export const viewport: Viewport = { themeColor: "#0A0A0A" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
