"use client";

import type { StatusDefinition, StatusGroup, StatusSetDefinition } from "@arbor/core";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  addStatusAction,
  attachStatusSetAction,
  deleteStatusAction,
  moveStatusAction,
  updateStatusAction,
} from "@/server/config-actions";

const GROUPS: { value: StatusGroup; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "active", label: "Active" },
  { value: "done", label: "Done" },
  { value: "closed", label: "Closed" },
];

interface ContainerOption {
  id: string;
  name: string;
  kind: string;
}

/**
 * One status set, editable in place.
 *
 * Every control here submits and waits — `startTransition` with an awaited
 * action, never fire-and-forget (D-040) — because these edits can be rejected
 * by the server for reasons the client cannot know: another person may have
 * just deleted the status this one is being renamed onto.
 */
export function StatusSetPanel({
  set,
  containerName,
  containers,
  taskCounts,
}: {
  set: StatusSetDefinition;
  containerName: string;
  containers: ContainerOption[];
  taskCounts: Record<string, number>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(null);
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <section className="settings-section" data-pending={pending || undefined}>
      <div className="settings-section-head">
        <h3 className="settings-heading">{set.name}</h3>
        <span className="settings-badge">{set.isTemplate ? "Template" : containerName}</span>

        {!set.isTemplate ? (
          <label className="settings-inline">
            <span>Applies to</span>
            <select
              value={set.containerId ?? ""}
              onChange={(event) =>
                run(() => attachStatusSetAction(set.id, event.target.value || null))
              }
            >
              <option value="">Workspace default</option>
              {containers.map((container) => (
                <option key={container.id} value={container.id}>
                  {container.name} ({container.kind})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <div className="status-list">
        {set.statuses.map((status, index) => (
          <StatusRow
            key={status.id}
            status={status}
            index={index}
            total={set.statuses.length}
            taskCount={taskCounts[status.id] ?? 0}
            siblings={set.statuses}
            deleting={deleting === status.id}
            onDeleteToggle={() => setDeleting(deleting === status.id ? null : status.id)}
            run={run}
          />
        ))}
      </div>

      {adding ? (
        <NewStatusRow setId={set.id} run={run} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" className="settings-add" onClick={() => setAdding(true)}>
          + Add status
        </button>
      )}

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

type Run = (action: () => Promise<{ ok: true } | { ok: false; error: string }>) => void;

function StatusRow({
  status,
  index,
  total,
  taskCount,
  siblings,
  deleting,
  onDeleteToggle,
  run,
}: {
  status: StatusDefinition;
  index: number;
  total: number;
  taskCount: number;
  siblings: StatusDefinition[];
  deleting: boolean;
  onDeleteToggle: () => void;
  run: Run;
}) {
  const [name, setName] = useState(status.name);
  const [replacement, setReplacement] = useState(
    siblings.find((s) => s.id !== status.id)?.id ?? "",
  );

  return (
    <div className="status-row">
      <span
        className="dot"
        data-group={status.group}
        style={{ borderColor: status.color, background: status.color }}
      />

      <input
        className="settings-input"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          if (name.trim() && name !== status.name) run(() => updateStatusAction(status.id, { name }));
          else setName(status.name);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setName(status.name);
            event.currentTarget.blur();
          }
        }}
      />

      <select
        className="settings-select"
        value={status.group}
        onChange={(event) =>
          run(() => updateStatusAction(status.id, { group: event.target.value as StatusGroup }))
        }
      >
        {GROUPS.map((group) => (
          <option key={group.value} value={group.value}>
            {group.label}
          </option>
        ))}
      </select>

      <input
        className="settings-color"
        type="color"
        value={status.color}
        onChange={(event) => run(() => updateStatusAction(status.id, { color: event.target.value }))}
        aria-label={`Colour of ${status.name}`}
      />

      <span className="settings-count">{taskCount || "—"}</span>

      <button
        type="button"
        className="settings-icon"
        disabled={index === 0}
        title="Move up"
        onClick={() => run(() => moveStatusAction(status.id, index - 1))}
      >
        ↑
      </button>
      <button
        type="button"
        className="settings-icon"
        disabled={index === total - 1}
        title="Move down"
        onClick={() => run(() => moveStatusAction(status.id, index + 1))}
      >
        ↓
      </button>
      <button type="button" className="settings-icon danger" title="Delete" onClick={onDeleteToggle}>
        ×
      </button>

      {deleting ? (
        <div className="settings-confirm">
          {/* The migration prompt. Deleting a status nulls the status of every
              task that used it (ON DELETE SET NULL), which would drop those
              tasks out of every grouped view — so the replacement is asked for,
              never guessed. */}
          <span>
            {taskCount > 0
              ? `${taskCount} task${taskCount === 1 ? "" : "s"} use this status. Move them to`
              : "Nothing uses this status. Delete it and move nothing to"}
          </span>
          <select value={replacement} onChange={(event) => setReplacement(event.target.value)}>
            {siblings
              .filter((sibling) => sibling.id !== status.id)
              .map((sibling) => (
                <option key={sibling.id} value={sibling.id}>
                  {sibling.name}
                </option>
              ))}
          </select>
          <button
            type="button"
            className="settings-danger"
            onClick={() => run(() => deleteStatusAction(status.id, replacement))}
          >
            Delete and move
          </button>
          <button type="button" className="settings-quiet" onClick={onDeleteToggle}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewStatusRow({
  setId,
  run,
  onCancel,
}: {
  setId: string;
  run: Run;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [group, setGroup] = useState<StatusGroup>("active");
  const [color, setColor] = useState("#5b8def");

  return (
    <div className="status-row">
      <span className="dot" data-group={group} style={{ borderColor: color, background: color }} />
      <input
        className="settings-input"
        autoFocus
        placeholder="Status name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && name.trim()) {
            run(() => addStatusAction(setId, name, group, color));
          }
          if (event.key === "Escape") onCancel();
        }}
      />
      <select
        className="settings-select"
        value={group}
        onChange={(event) => setGroup(event.target.value as StatusGroup)}
      >
        {GROUPS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        className="settings-color"
        type="color"
        value={color}
        onChange={(event) => setColor(event.target.value)}
        aria-label="Colour of the new status"
      />
      <span className="settings-count">—</span>
      <button
        type="button"
        className="settings-primary"
        disabled={!name.trim()}
        onClick={() => run(() => addStatusAction(setId, name, group, color))}
      >
        Add
      </button>
      <button type="button" className="settings-quiet" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
