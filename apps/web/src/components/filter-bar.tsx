"use client";

import { type FilterGroup, encodeFilters } from "@arbor/core";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { ConditionEditor, type FilterOptionValues } from "./filter-conditions";
import type { FilterableField } from "@arbor/core";

/**
 * The filter bar.
 *
 * **The menus live in `filter-conditions.tsx` now**, because a rule's
 * conditions are the same `FilterGroup` and an automation form would otherwise
 * be a second opinion about what "status is Done" looks like. What is left here
 * is the part that is only true of a view: **state lives in the URL, not in
 * this component.** A filtered view is the thing people share — "everything
 * overdue and unassigned" — and component state makes exactly the useful views
 * unshareable and loses them on reload.
 */

export type { FilterOptionValues } from "./filter-conditions";

export function FilterBar({
  fields,
  values,
  filters,
}: {
  fields: FilterableField[];
  values: FilterOptionValues;
  filters: FilterGroup;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function commit(next: FilterGroup) {
    const encoded = encodeFilters(next);
    const query = new URLSearchParams(params.toString());

    if (encoded) query.set("f", encoded);
    else query.delete("f");

    const search = query.toString();
    startTransition(() => {
      router.push(search ? `?${search}` : "?", { scroll: false });
    });
  }

  return (
    <div className="filter-bar" data-pending={pending || undefined}>
      <ConditionEditor fields={fields} values={values} group={filters} onChange={commit} />

      {/* Not a condition: `showClosed` is a property of the query a view runs,
          and it has no meaning for a rule being asked about one task. */}
      <label className="filter-toggle">
        <input
          type="checkbox"
          checked={filters.showClosed === true}
          onChange={(event) => commit({ ...filters, showClosed: event.target.checked })}
        />
        <span>Show closed</span>
      </label>
    </div>
  );
}
