"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/settings/statuses", label: "Statuses", icon: "◍" },
  { href: "/settings/fields", label: "Custom fields", icon: "⌗" },
  { href: "/settings/types", label: "Task types", icon: "◈" },
];

export function SettingsTabs() {
  const pathname = usePathname();

  return (
    <>
      {SECTIONS.map((section) => (
        <Link
          key={section.href}
          className="nav"
          href={section.href}
          aria-current={pathname === section.href ? "page" : undefined}
        >
          <span className="ic">{section.icon}</span>
          {section.label}
        </Link>
      ))}
    </>
  );
}
