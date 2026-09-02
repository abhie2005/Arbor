"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  createTaskTypeAction,
  deleteTaskTypeAction,
  setDefaultTaskTypeAction,
  updateTaskTypeAction,
} from "@/server/config-actions";

interface TaskTypeRow {
  id: string;
  name: string;
  icon: string | null;
  isDefault: boolean;
  taskCount: number;
  scopedFields: string[];
}

export function TaskTypeList({ taskTypes }: { taskTypes: TaskTypeRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(null);
      setNewName("");
      router.refresh();
    });
  }

  return (
    <section className="settings-section" data-pending={pending || undefined}>
      <div className="field-list">
        {taskTypes.map((taskType) => (
          <div className="field-panel" key={taskType.id}>
            <div className="type-row">
              <TypeName taskType={taskType} run={run} />

              {taskType.isDefault ? (
                <span className="settings-badge">Default</span>
              ) : (
                <button
                  type="button"
                  className="settings-quiet"
                  onClick={() => run(() => setDefaultTaskTypeAction(taskType.id))}
                >
                  Make default
                </button>
              )}

              <span className="settings-badge quiet">
                {taskType.scopedFields.length > 0
                  ? taskType.scopedFields.join(", ")
                  : "no scoped fields"}
              </span>

              <span className="settings-count">{taskType.taskCount || "—"}</span>

              <button
                type="button"
                className="settings-icon danger"
                title="Delete"
                onClick={() => setDeleting(deleting === taskType.id ? null : taskType.id)}
              >
                ×
              </button>
            </div>

            {deleting === taskType.id ? (
              <div className="settings-confirm">
                {/* "No type" is a legal state for a task — it simply shows the
                    unscoped fields — so unlike a status this offers clearing
                    as well as reassignment. */}
                <span>
                  {taskType.taskCount > 0
                    ? `${taskType.taskCount} task${taskType.taskCount === 1 ? "" : "s"} use this type. Move them to`
                    : "Nothing uses this type. Move nothing to"}
                </span>
                <TypeReplacement
                  options={taskTypes.filter((t) => t.id !== taskType.id)}
                  onDelete={(replacementId) =>
                    run(() => deleteTaskTypeAction(taskType.id, replacementId))
                  }
                />
                <button
                  type="button"
                  className="settings-quiet"
                  onClick={() => setDeleting(null)}
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <div className="settings-form">
        <input
          className="settings-input"
          placeholder="New task type"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newName.trim()) {
              run(() => createTaskTypeAction(newName, ""));
            }
          }}
        />
        <button
          type="button"
          className="settings-primary"
          disabled={!newName.trim()}
          onClick={() => run(() => createTaskTypeAction(newName, ""))}
        >
          Add type
        </button>
      </div>

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function TypeName({
  taskType,
  run,
}: {
  taskType: TaskTypeRow;
  run: (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;
}) {
  const [name, setName] = useState(taskType.name);

  return (
    <input
      className="settings-input"
      value={name}
      onChange={(event) => setName(event.target.value)}
      onBlur={() => {
        if (name.trim() && name !== taskType.name) {
          run(() => updateTaskTypeAction(taskType.id, { name }));
        } else {
          setName(taskType.name);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setName(taskType.name);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function TypeReplacement({
  options,
  onDelete,
}: {
  options: { id: string; name: string }[];
  onDelete: (replacementId: string | null) => void;
}) {
  const [replacement, setReplacement] = useState<string>("");

  return (
    <>
      <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
        <option value="">No type</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="settings-danger"
        onClick={() => onDelete(replacement || null)}
      >
        Delete and move
      </button>
    </>
  );
}
