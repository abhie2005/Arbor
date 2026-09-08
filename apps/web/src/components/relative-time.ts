/**
 * How long ago, coarsely.
 *
 * Extracted at the second copy rather than the sixth (the shell's lesson): the
 * inbox and a comment thread are both lists of things that happened, and two
 * private copies of this would drift the moment one of them learned about days.
 * Coarse on purpose — neither screen needs seconds.
 */
export function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
