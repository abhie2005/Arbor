import type { Metadata } from "next";
import type { ReactNode } from "react";

import { ensureAutomationLoop } from "@/server/automation-loop";

import "@arbor/ui/tokens.css";
import "./app.css";

export const metadata: Metadata = {
  title: "Arbor",
  description: "A dense, keyboard-driven work platform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  // The other guaranteed entry point, and the one that covers development:
  // nothing hits `/api/health` on a laptop, and an engine that only runs in
  // production is one nobody notices is broken until it is deployed (D-125).
  ensureAutomationLoop();

  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
