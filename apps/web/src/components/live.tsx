"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/**
 * Keeps the screen live, and says who else is on it.
 *
 * Renders nothing of its own. It holds one `EventSource` to `/api/live` and
 * handles the two things that come down it:
 *
 * - a **change** — "something happened in list L" — answered with
 *   `router.refresh()`, which re-runs the server components of whatever page is
 *   mounted and patches the result in, keeping scroll, focus and client state
 *   (D-090). The nudge says nothing about *what* changed, because the page is a
 *   server component and re-running it is the update.
 * - a **presence** — the people currently looking at this scope — put into
 *   context instead. Presence is ephemeral and belongs to one small component;
 *   re-rendering a page every time somebody opens a tab would be absurd
 *   (D-092).
 * - a **timer** — what this viewer has running — also into context, and the
 *   only message that arrives for changes *you* made. A refresh would not do
 *   it: your own writes are filtered out below, so a timer started in another
 *   tab would never reach this one, and the readout would go on claiming a
 *   timer was running on a task where it had already been stopped (D-098).
 *
 * One connection for both, and the scope is in its URL: changing what you are
 * looking at reopens the stream, which is the browser telling the server where
 * it is without ever sending a message.
 */

export interface Person {
  id: string;
  name: string;
}

/** What the stream says this viewer has running. Mirrors `RunningEntry`. */
export interface RunningTimer {
  id: string;
  taskId: string;
  startedAt: string;
  description: string | null;
  isBillable: boolean;
  taskKey: string | null;
  taskName: string | null;
}

const PresenceContext = createContext<Person[]>([]);

/**
 * `undefined` means the stream has not spoken yet, which is different from
 * `null` — "nothing is running". The readout renders what the server gave it
 * until the first is true, and what the stream says forever after.
 */
const TimerContext = createContext<RunningTimer | null | undefined>(undefined);

/** The people on this screen with you. Empty on screens that have no scope. */
export function useWatching(): Person[] {
  return useContext(PresenceContext);
}

/** The viewer's running timer, or undefined until the stream has said. */
export function useRunningTimer(): RunningTimer | null | undefined {
  return useContext(TimerContext);
}

export function Live({
  viewerId,
  scope,
  children,
}: {
  viewerId: string;
  /** What this screen is looking at, when it is one thing. */
  scope?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [people, setPeople] = useState<Person[]>([]);
  const [timer, setTimer] = useState<RunningTimer | null | undefined>(undefined);

  useEffect(() => {
    const source = new EventSource(scope ? `/api/live?scope=${encodeURIComponent(scope)}` : "/api/live");
    let pending: ReturnType<typeof setTimeout> | undefined;

    /**
     * Coalesced: a batch arrives as several nudges only when it touched several
     * lists, and one refresh answers all of them.
     *
     * A refresh is only half of an update. Whether the screen actually changes
     * is up to the components it re-renders, and a control holding
     * `useState(props.value)` will keep showing the old one with nothing
     * failing anywhere — see `use-server-value.ts`, which is what made this
     * work.
     */
    const scheduleRefresh = () => {
      clearTimeout(pending);
      pending = setTimeout(() => router.refresh(), 250);
    };

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

      scheduleRefresh();
    };

    source.addEventListener("timer", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as {
          running: RunningTimer | null;
        };
        setTimer(update.running);

        // **And refresh, even though this is your own change.** The readout in
        // the chrome is not the only thing on screen that knows about a timer:
        // the task page lists the entry and shows it running. Updating one and
        // not the other leaves a screen disagreeing with itself, which is worse
        // than either half being stale — the header said nothing was running
        // while the panel three inches below it offered to stop something.
        //
        // The tab that made the change has already refreshed on the way back
        // from the action; a second one 250ms later costs a re-render of server
        // components that were about to be correct anyway.
        scheduleRefresh();
      } catch {
        // A payload that will not parse is a publisher bug, not a reason to
        // tear the stream down.
      }
    });

    source.addEventListener("presence", (event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as {
          scope: string;
          people: Person[];
        };
        // Already "who else": the server filters this viewer out when it builds
        // the payload, so there is one place that knows the rule.
        setPeople(update.people);
      } catch {
        // A payload that will not parse is a publisher bug, not a reason to
        // tear the stream down.
      }
    });

    return () => {
      clearTimeout(pending);
      source.close();
      // The people on the old scope are not the people on the new one, and a
      // stale set is worse than none while the next stream opens.
      setPeople([]);
      // The timer is *not* cleared. It belongs to the viewer rather than to the
      // scope, the new page renders the server's value for it anyway, and
      // dropping back to "undefined" here would make the readout flicker on
      // every navigation.
    };
  }, [router, viewerId, scope]);

  return (
    <PresenceContext.Provider value={people}>
      <TimerContext.Provider value={timer}>{children}</TimerContext.Provider>
    </PresenceContext.Provider>
  );
}
