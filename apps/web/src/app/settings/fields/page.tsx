import { FIELD_TYPES, FIELD_TYPE_META } from "@arbor/core";
import { listTaskTypes, loadContainerTree, loadFieldPlacements, pool } from "@arbor/db";

import { FieldList } from "@/components/settings/field-list";
import { NewField } from "@/components/settings/new-field";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

/** How many tasks hold a value for each field — the cost of archiving one. */
async function valueCounts(workspaceId: string): Promise<Map<string, number>> {
  const result = await pool().query<{ field_id: string; n: string }>(
    `SELECT fv.field_id, COUNT(*) AS n
     FROM field_values fv
     JOIN fields f ON f.id = fv.field_id
     WHERE f.workspace_id = $1
       AND COALESCE(fv.value_text, fv.value_num::text, fv.value_date::text,
                    fv.value_bool::text, fv.value_json::text) IS NOT NULL
     GROUP BY fv.field_id`,
    [workspaceId],
  );
  return new Map(result.rows.map((row) => [row.field_id, Number(row.n)]));
}

export default async function FieldsPage() {
  const workspace = await requireWorkspace();
  const [fields, containers, taskTypes, counts] = await Promise.all([
    loadFieldPlacements(workspace.id),
    loadContainerTree(workspace.id),
    listTaskTypes(workspace.id),
    valueCounts(workspace.id),
  ]);

  const containerOptions = [...containers.values()].map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
  }));

  const typeOptions = FIELD_TYPES.map((type) => ({
    value: type,
    label: FIELD_TYPE_META[type].label,
    derived: FIELD_TYPE_META[type].derived,
  }));

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>›</span>
          <strong>Custom fields</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A field defined on a space is available to every list beneath it. Unlike a status set,
          fields accumulate down the tree rather than overriding — a list adds to what it inherits.
        </p>

        <FieldList
          fields={fields.map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type,
            typeConfig: field.typeConfig as Record<string, unknown>,
            containerId: field.containerId,
            containerName: field.containerId
              ? (containers.get(field.containerId)?.name ?? "—")
              : "Workspace",
            scopeTaskTypeIds: field.scopeTaskTypeIds,
            archived: field.archived,
            valueCount: counts.get(field.id) ?? 0,
          }))}
          taskTypes={taskTypes.map((t) => ({ id: t.id, name: t.name }))}
          fieldTypes={typeOptions}
        />

        <NewField containers={containerOptions} fieldTypes={typeOptions} />
      </div>
    </>
  );
}
