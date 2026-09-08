"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Keeps the screen live.
 *
 * Renders nothing. It holds an `EventSource` open to `/api/live` and calls
 * `router.refresh()` when something the viewer can see has changed — which
 * re-runs the server components of whatever page is mounted and patches the
 * result in, without losing scroll position, focus, or any client state
 * (D-090). Every screen gets it because it is mounted in the shell, so "which
 * pages are live" is not a question anyone has to keep answering.
 *
 * **The nudge says nothing about what changed**, and this is why that is
 * enough: the page is a server component, so re-running it *is* the update. A
 * renderer that applied deltas by hand would be a second description of every
 * mutation, in a second shape, kept in step with the first by nobody.
 */
export function Live({ viewerId }: { viewerId: string }) {
  const router = useRouter();

  useEffect(() => {
    const source = new EventSource("/api/live");
    let pending: ReturnType<typeof setTimeout> | undefined;

    source.onmessage = (event) => {
      let change: { a?: string };
      try {
        change = JSON.parse(event.data) as { a?: string };
      } catch {
        return;
      }

      // Your own writes already refreshed the page — the action that made them
      // revalidated on the way back. Refreshing again would be a second render
      // for every keystroke-sized edit, and it is the one that would fight with
      // an optimistic control.
      if (change.a === viewerId) return;

      // Coalesced: a batch arrives as several nudges only when it touched
      // several lists, and one refresh answers all of them.
      //
      // A refresh is only half of an update. Whether the screen actually
      // changes is up to the components it re-renders, and a control holding
      // `useState(props.value)` will keep showing the old one with nothing
      // failing anywhere — see `use-server-value.ts`, which is what made this
      // work.
      clearTimeout(pending);
      pending = setTimeout(() => router.refresh(), 250);
    };

    return () => {
      clearTimeout(pending);
      source.close();
    };
  }, [router, viewerId]);

  return null;
}
