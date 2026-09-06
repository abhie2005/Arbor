"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The renderer switcher.
 *
 * These are routes, not local state, for the same reason the detail panel and
 * the settings screen are (D-031): "look at the board" is a thing people send
 * each other, and a tab that only exists in memory has no address.
 *
 * Renderers that do not exist yet are rendered but inert rather than hidden —
 * the compiler already produces everything they need, and showing the gap is
 * more honest than pretending the product is only a list.
 */
const RENDERERS = [
  { label: "List", href: "/" },
  { label: "Board", href: "/board" },
  { label: "Calendar", href: null },
  { label: "Table", href: null },
];

export function ViewTabs() {
  const pathname = usePathname();

  return (
    <div className="tabs">
      {RENDERERS.map((renderer) =>
        renderer.href ? (
          <Link
            key={renderer.label}
            className="tab"
            href={renderer.href}
            aria-current={pathname === renderer.href ? "page" : undefined}
          >
            {renderer.label}
          </Link>
        ) : (
          <span key={renderer.label} className="tab" data-unbuilt title="Not built yet">
            {renderer.label}
          </span>
        ),
      )}
    </div>
  );
}
