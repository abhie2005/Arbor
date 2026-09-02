import { listTaskTypes, loadFieldPlacements } from "@arbor/db";

import { TaskTypeList } from "@/components/settings/task-type-list";
import { requireWorkspace } from "@/server/workspace";

export const dynamic = "force-dynamic";

export default async function TaskTypesPage() {
  const workspace = await requireWorkspace();
  const [taskTypes, fields] = await Promise.all([
    listTaskTypes(workspace.id),
    loadFieldPlacements(workspace.id),
  ]);

  // Which fields each type pulls in. This is the whole reason task types exist,
  // so the screen shows it rather than making the reader cross-reference the
  // custom fields page.
  const fieldsByType = new Map<string, string[]>();
  for (const field of fields) {
    for (const taskTypeId of field.scopeTaskTypeIds) {
      fieldsByType.set(taskTypeId, [...(fieldsByType.get(taskTypeId) ?? []), field.name]);
    }
  }

  return (
    <>
      <header className="header">
        <div className="crumb">
          Settings<span>›</span>
          <strong>Task types</strong>
        </div>
      </header>

      <div className="settings-body">
        <p className="settings-note">
          A type decides which custom fields a task renders — a Bug shows Severity and a Task never
          does. Fields with no type restriction appear on everything.
        </p>

        <TaskTypeList
          taskTypes={taskTypes.map((type) => ({
            ...type,
            scopedFields: fieldsByType.get(type.id) ?? [],
          }))}
        />
      </div>
    </>
  );
}
