"use client";

/**
 * A person, in 17 pixels.
 *
 * Extracted at the fourth copy — the list row, the board card and the table
 * cell each had their own `initials` and `avatarColor`, and presence was about
 * to be the fourth. They had not drifted yet, which is the only good time to do
 * this: the colour is a hash of the name, so two copies falling out of step
 * would give the same person different colours on different screens, and
 * nothing would fail.
 */
export function Avatar({ name, title }: { name: string; title?: string }) {
  return (
    <span className="avatar" style={{ background: avatarColor(name) }} title={title ?? name}>
      {initials(name)}
    </span>
  );
}

export function initials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/**
 * Hashed from the name rather than stored, so a person is the same colour
 * everywhere without anything having to remember which colour they were.
 */
function avatarColor(name: string): string {
  const hues = [
    "var(--avatar-1)",
    "var(--avatar-2)",
    "var(--avatar-3)",
    "var(--avatar-4)",
    "var(--avatar-5)",
  ];

  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length]!;
}
