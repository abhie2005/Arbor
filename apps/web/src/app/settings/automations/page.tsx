import { ancestorsOf } from "@arbor/core";
import {
  automationQuota,
  loadAutomationsForContainers,
  loadContainerTree,
  reachableContainers,
} from "@arbor/db";

import {
  type AutomationRow,
  AutomationsPanel,
  type RuleContainer,
} from "@/components/settings/automations-panel";
import { requireUser } from "@/server/auth";
import { loadFilterOptions } from "@/server/views";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * The automations screen.
 *
 * The engine has been running since D-125 and a rule could only be created by
 * calling `createAutomation` — which made every rule in existence one somebody
 * wrote in a smoke test. This is the screen that was owed.
 *
 * **It lists what the viewer may automate, not what exists**, the shape D-123
 * arrived at the hard way: a page that enumerates containers has to join the
 * access index, or it names private spaces to anybody who opens it. `manage` is
 * the permission, which is the same thing the actions behind the screen take —
 * listing a container you can see but not automate would be a panel whose every
 * control refuses.
 *
 * **The conditions are the filter bar's own menus** (`filter-conditions.tsx`),
 * because a rule's conditions *are* a `FilterGroup` and the compiler is what
 * evaluates them at run time. A second condition editor here would be a second
 * opinion about what "status is Done" means, and the two would drift the first
 * time an operator was added.
 */
export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ container?: string }>;
}) {
  const { container } = await searchParams;
  const workspace = await requireWorkspace();
  const viewer = await requireUser();

  const tree = await loadContainerTree(workspace.id);
  const manageable = await reachableContainers(workspace.id, viewer.id, "manage");
  const nodes = [...tree.values()];

  // Depth-first, so the picker reads as the tree it is.
  const ordered: typeof nodes = [];
  const walk = (parentId: string | null) => {
    for (const node of nodes
      .filter((candidate) => candidate.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))) {
      ordered.push(node);
      walk(node.id);
    }
  };
  walk(null);

  const containers: RuleContainer[] = ordered
    .filter((node) => manageable.has(node.id))
    .map((node) => ({
      id: node.id,
      name: node.name,
      kind: node.kind,
      // Only ancestors that are themselves on screen, so the indentation
      // describes what is listed rather than the tree behind it.
      depth: ancestorsOf(node.id, tree).filter(
        (ancestor) => ancestor.id !== node.id && manageable.has(ancestor.id),
      ).length,
    }));

  // A container named in the URL is honoured only if it is one of these: a link
  // to a space somebody cannot automate falls back rather than refusing,
  // because a refusal that differed from "no such container" would say which of
  // the two it was (invariant 6).
  const selected = containers.find((node) => node.id === container) ?? containers[0] ?? null;

  const [summaries, options, quota] = await Promise.all([
    selected ? loadAutomationsForContainers([selected.id]) : Promise.resolve([]),
    loadFilterOptions(workspace.id),
    automationQuota(workspace.id),
  ]);

  // Instants cross to the client as ISO strings and are rendered by
  // `Timestamp`, which is the only thing here allowed to decide a zone (D-121).
  const rules: AutomationRow[] = summaries.map((summary) => ({
    id: summary.id,
    name: summary.name,
    rule: summary.rule,
    problem: summary.problem,
    isEnabled: summary.isEnabled,
    createdAt: summary.createdAt.toISOString(),
    createdByName: summary.createdByName,
    runs: summary.runs,
    lastRun: summary.lastRun
      ? {
          status: summary.lastRun.status,
          error: summary.lastRun.error,
          attempts: summary.lastRun.attempts,
          startedAt: summary.lastRun.startedAt.toISOString(),
          finishedAt: summary.lastRun.finishedAt?.toISOString() ?? null,
          runAfter: summary.lastRun.runAfter.toISOString(),
        }
      : null,
  }));

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>&#8250;</span>
          <strong>Automations</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A rule watches its container&rsquo;s subtree: one on a space covers every list inside it.
          It acts as the workspace&rsquo;s automation account, writes through the same operations a
          person does, and never answers its own output. Conditions are asked when the rule acts,
          not when it was queued — which is what &ldquo;in 3 days, if still open&rdquo; means.
        </p>

        <AutomationsPanel
          containers={containers}
          selected={selected}
          rules={rules}
          fields={options.fields}
          values={{
            statuses: options.statuses,
            statusGroups: options.statusGroups,
            priorities: options.priorities,
            users: options.users,
            tags: options.tags,
            taskTypes: options.taskTypes,
            // The lists this viewer manages, for a "move to list" action. Not
            // every container in the workspace: that read is the one D-123 was
            // about, and a rule can only move a task somewhere its author may
            // act anyway.
            containers: containers
              .filter((node) => node.kind === "list")
              .map((node) => ({ id: node.id, name: node.name })),
          }}
          quota={quota}
        />
      </div>
    </>
  );
}
