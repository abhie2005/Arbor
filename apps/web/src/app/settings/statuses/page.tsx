import { STATUS_TEMPLATES } from "@arbor/core";
import { loadContainerTree, loadStatusSets, pool, resolveStatusSetFor } from "@arbor/db";

import { NewStatusSet } from "@/components/settings/new-status-set";
import { StatusSetPanel } from "@/components/settings/status-set-panel";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/**
 * How many tasks sit on each status, for the deletion prompt.
 *
 * Loaded once for the whole page rather than per status: the prompt has to be
 * able to say "12 tasks" the instant someone clicks delete, and a query at
 * that moment would either block the click or arrive after the decision.
 */
async function taskCountsByStatus(workspaceId: string): Promise<Map<string, number>> {
  const result = await pool().query<{ status_id: string; n: string }>(
    `SELECT status_id, COUNT(*) AS n FROM tasks
     WHERE workspace_id = $1 AND status_id IS NOT NULL AND deleted_at IS NULL
     GROUP BY status_id`,
    [workspaceId],
  );
  return new Map(result.rows.map((row) => [row.status_id, Number(row.n)]));
}

export default async function StatusesPage() {
  const workspace = await requireWorkspace();
  const [sets, containers, counts] = await Promise.all([
    loadStatusSets(workspace.id),
    loadContainerTree(workspace.id),
    taskCountsByStatus(workspace.id),
  ]);

  const lists = [...containers.values()].filter((c) => c.kind === "list");

  // What each list actually resolves to, so the page can show inheritance as a
  // fact rather than as a rule the reader has to apply themselves.
  const resolutions = await Promise.all(
    lists.map(async (list) => ({
      list,
      resolved: await resolveStatusSetFor(workspace.id, list.id),
    })),
  );

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>›</span>
          <strong>Statuses</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A list uses its own status set, else its nearest ancestor&rsquo;s, else the workspace
          default. The same walk resolves every inherited setting.
        </p>

        <section className="settings-section">
          <h3 className="settings-heading">What each list resolves to</h3>
          <div className="resolution-table">
            {resolutions.map(({ list, resolved }) => (
              <div className="resolution-row" key={list.id}>
                <span className="resolution-name">{list.name}</span>
                <span className="resolution-set">{resolved.set.name}</span>
                <span className="resolution-source">
                  {resolved.isOwn ? "defined here" : `inherited from ${resolved.sourceName}`}
                </span>
              </div>
            ))}
          </div>
        </section>

        {sets.map((set) => (
          <StatusSetPanel
            key={set.id}
            set={set}
            containerName={
              set.containerId ? (containers.get(set.containerId)?.name ?? "—") : "Workspace default"
            }
            containers={[...containers.values()].map((c) => ({
              id: c.id,
              name: c.name,
              kind: c.kind,
            }))}
            taskCounts={Object.fromEntries(
              set.statuses.map((status) => [status.id, counts.get(status.id) ?? 0]),
            )}
          />
        ))}

        <NewStatusSet templates={STATUS_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description }))} />
      </div>
    </>
  );
}
