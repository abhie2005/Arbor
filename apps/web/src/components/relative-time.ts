import { instantDay } from "@arbor/core";

/**
 * How long ago, coarsely.
 *
 * Extracted at the second copy rather than the sixth (the shell's lesson): the
 * inbox and a comment thread are both lists of things that happened, and two
 * private copies of this would drift the moment one of them learned about days.
 * Coarse on purpose — neither screen needs seconds.
 *
 * **`timeZone` is for the last line only**, and it is not optional information
 * dressed up as a parameter. Everything above that line is a difference between
 * two instants and means the same thing anywhere; the fallback is a *date*, and
 * a date has to be read in some zone. Leaving it implied is what made the same
 * document read "10 Oct" on a UTC server and "9 Oct" in a Pacific browser
 * (D-121).
 *
 * So: pass a zone when something other than a browser is going to render the
 * result — a server component has no viewer to be local to. Pass nothing when
 * the browser is the only thing calling it, which is what `Timestamp` arranges
 * by calling this after hydration and never before.
 */
export function relative(iso: string, timeZone?: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return instantDay(iso, timeZone);
}
