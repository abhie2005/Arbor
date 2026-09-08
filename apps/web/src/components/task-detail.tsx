"use client";

import { type Operation, dateFrame, isOverdue } from "@arbor/core";
import { useState } from "react";

import {
  archiveTask,
  renameTask,
  setCustomFieldValue,
  setPriority,
  setTaskDate,
  setTaskDescription,
  setTaskRelation,
  setTaskStatus,
  setTaskType,
} from "@/server/actions";

import { Comments } from "./comments";
import { useServerValue } from "./use-server-value";
import { useTaskAction } from "./use-task-action";
import type { CommentRecord } from "@arbor/db";
import type { DetailField, Person, Subtask } from "@/server/task";

/**
 * The task detail page's controls.
 *
 * Everything that writes goes through `useTaskAction` (D-064), so all four
 * rules a writing control needs — run in a transition, push the server's
 * inverse unchanged, show the failure, revert to the server's value — arrive
 * here without being restated. That is what the hook was extracted for, and
 * this is the third renderer to get them free.
 *
 * **A viewer without `edit` sees values, not controls.** Not disabled controls:
 * a disabled select still reads as something you could have used if you tried
 * harder. The same rule as the table headers that cannot sort (D-065).
 */

export interface TaskDetailData {
  id: string;
  key: string | null;
  name: string;
  statusId: string | null;
  priority: number | null;
  dueAt: string | null;
  dueHasTime: boolean;
  startAt: string | null;
  startHasTime: boolean;
  taskTypeId: string | null;
  canEdit: boolean;
  statuses: { id: string; name: string; group: string; color: string }[];
  taskTypes: Person[];
  people: Person[];
  assigneeIds: string[];
  watcherIds: string[];
  fields: DetailField[];
  subtasks: Subtask[];
  descriptionText: string;
  comments: CommentRecord[];
}

const PRIORITIES = [
  { value: null, label: "None" },
  { value: 1, label: "Urgent" },
  { value: 2, label: "High" },
  { value: 3, label: "Normal" },
  { value: 4, label: "Low" },
];

export function TaskDetail({ task, viewerId }: { task: TaskDetailData; viewerId: string }) {
  // The title is a live input, so "being edited" is "focused" here rather than
  // a mode: a rename arriving from somebody else must not take the caret out of
  // a sentence someone is halfway through (D-090).
  const [titleFocused, setTitleFocused] = useState(false);
  const [name, setName] = useServerValue(task.name, titleFocused);
  const { run, pending, failure } = useTaskAction();
  const act = (action: () => Promise<Operation[]>, revert?: () => void) => run(action, revert);

  const status = task.statuses.find((candidate) => candidate.id === task.statusId);

  return (
    <div className="detail" data-pending={pending || undefined}>
      <div className="detail-head">
        <span className="dot" data-group={status?.group ?? undefined} />
        <span className="key">{task.key ?? "—"}</span>

        {task.canEdit ? (
          <input
            className="detail-title"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onFocus={() => setTitleFocused(true)}
            onBlur={() => {
              setTitleFocused(false);
              if (name.trim() && name !== task.name) {
                act(() => renameTask(task.id, name), () => setName(task.name));
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(task.name);
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h1 className="detail-title-static">{name}</h1>
        )}

        {task.canEdit ? (
          <button
            type="button"
            className="archive"
            title="Archive"
            aria-label={`Archive ${task.name}`}
            onClick={() => act(() => archiveTask(task.id))}
          >
            ×
          </button>
        ) : null}
      </div>

      {failure ? (
        <p className="detail-error" role="alert">
          {failure}
        </p>
      ) : null}

      {!task.canEdit ? (
        <p className="detail-note">
          You can see this task but not change it. Everything below is read-only.
        </p>
      ) : null}

      <DescriptionBox
        taskId={task.id}
        initial={task.descriptionText}
        canEdit={task.canEdit}
        act={act}
      />

      <dl className="detail-fields">
        <Row label="Status">
          {task.canEdit ? (
            <select
              value={task.statusId ?? ""}
              onChange={(event) => {
                const to = event.target.value;
                act(() => setTaskStatus(task.id, to));
              }}
            >
              {task.statuses.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{status?.name ?? "—"}</span>
          )}
        </Row>

        <Row label="Priority">
          {task.canEdit ? (
            <select
              value={task.priority ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                act(() => setPriority(task.id, raw === "" ? null : Number(raw)));
              }}
            >
              {PRIORITIES.map((option) => (
                <option key={option.label} value={option.value ?? ""}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <span>{PRIORITIES.find((p) => p.value === task.priority)?.label ?? "None"}</span>
          )}
        </Row>

        <DateRow
          label="Start date"
          taskId={task.id}
          field="startAt"
          value={task.startAt}
          hasTime={task.startHasTime}
          canEdit={task.canEdit}
          act={act}
        />
        <DateRow
          label="Due date"
          taskId={task.id}
          field="dueAt"
          value={task.dueAt}
          hasTime={task.dueHasTime}
          canEdit={task.canEdit}
          act={act}
        />

        <Row label="Task type">
          {task.canEdit ? (
            <select
              value={task.taskTypeId ?? ""}
              onChange={(event) => {
                const raw = event.target.value;
                act(() => setTaskType(task.id, raw === "" ? null : raw));
              }}
            >
              <option value="">None</option>
              {task.taskTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{task.taskTypes.find((t) => t.id === task.taskTypeId)?.name ?? "None"}</span>
          )}
        </Row>

        <PeopleRow
          label="Assignees"
          taskId={task.id}
          relation="assignee"
          people={task.people}
          selected={task.assigneeIds}
          canEdit={task.canEdit}
          act={act}
        />
        <PeopleRow
          label="Watchers"
          taskId={task.id}
          relation="watcher"
          people={task.people}
          selected={task.watcherIds}
          canEdit={task.canEdit}
          act={act}
        />

        {task.fields.map((field) => (
          <CustomFieldRow
            key={field.fieldId}
            taskId={task.id}
            field={field}
            canEdit={task.canEdit}
            act={act}
          />
        ))}
      </dl>

      <Comments
        taskId={task.id}
        comments={task.comments}
        people={task.people}
        canComment={task.canEdit}
        viewerId={viewerId}
      />

      {task.subtasks.length > 0 ? (
        <section className="detail-section">
          <h2>Subtasks</h2>
          <ul className="detail-subtasks">
            {task.subtasks.map((subtask) => (
              <li key={subtask.id}>
                <span className="dot" data-group={subtask.statusGroup ?? undefined} />
                <a href={`/t/${subtask.key ?? subtask.id}`}>
                  <span className="key">{subtask.key ?? "—"}</span>
                  {subtask.name}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The description.
 *
 * The same document format as a comment, typed into the same kind of box, so a
 * mention works here too and Phase 9's collaborative editor replaces one shape
 * rather than two (D-083). Saved on blur rather than on every keystroke: a
 * description is a paragraph someone is composing, and an operation per
 * character would be an activity log nobody could read.
 */
function DescriptionBox({
  taskId,
  initial,
  canEdit,
  act,
}: {
  taskId: string;
  initial: string;
  canEdit: boolean;
  act: (action: () => Promise<Operation[]>, revert?: () => void) => void;
}) {
  const [text, setText] = useState(initial);

  if (!canEdit) {
    return initial ? (
      <div className="detail-description detail-description-static">
        {initial.split("\n\n").map((paragraph, index) => (
          // eslint-disable-next-line react/no-array-index-key -- paragraphs have no id
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    ) : null;
  }

  return (
    <textarea
      className="detail-description"
      rows={3}
      value={text}
      placeholder="Add a description. Type @ and a name to mention someone."
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        if (text !== initial) act(() => setTaskDescription(taskId, text), () => setText(initial));
      }}
    />
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * A date input speaks `YYYY-MM-DD`, which is the same thing the calendar drag
 * sends and the same thing `setTaskDate` stores at midnight UTC (D-067). So a
 * date typed here and a task dragged onto a square produce the identical row.
 */
function DateRow({
  label,
  taskId,
  field,
  value,
  hasTime,
  canEdit,
  act,
}: {
  label: string;
  taskId: string;
  field: "dueAt" | "startAt";
  value: string | null;
  hasTime: boolean;
  canEdit: boolean;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const day = value ? value.slice(0, 10) : "";

  return (
    <Row label={label}>
      {canEdit ? (
        <input
          type="date"
          value={day}
          onChange={(event) => {
            const next = event.target.value;
            act(() => setTaskDate(taskId, field, next === "" ? null : next));
          }}
        />
      ) : (
        <span data-overdue={value ? isOverdue(value, hasTime) : undefined}>
          {value
            ? new Date(value).toLocaleDateString("en-GB", {
                weekday: "short",
                day: "numeric",
                ...dateFrame(hasTime),
              })
            : "—"}
        </span>
      )}
    </Row>
  );
}

/**
 * Checkboxes rather than a multi-select.
 *
 * Each toggle is its own operation and its own undo entry, which is what the
 * relation ops already are — a multi-select would have to diff two sets and
 * emit a batch, inventing a compound operation for a control nobody asked to
 * be compound.
 */
function PeopleRow({
  label,
  taskId,
  relation,
  people,
  selected,
  canEdit,
  act,
}: {
  label: string;
  taskId: string;
  relation: "assignee" | "watcher";
  people: Person[];
  selected: string[];
  canEdit: boolean;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const chosen = new Set(selected);

  return (
    <Row label={label}>
      {canEdit ? (
        <div className="detail-people">
          {people.map((person) => (
            <label key={person.id} className="detail-person">
              <input
                type="checkbox"
                checked={chosen.has(person.id)}
                onChange={(event) => {
                  const present = event.target.checked;
                  act(() => setTaskRelation(taskId, relation, person.id, present));
                }}
              />
              {person.name}
            </label>
          ))}
        </div>
      ) : (
        <span>
          {selected.length === 0
            ? "—"
            : people
                .filter((person) => chosen.has(person.id))
                .map((person) => person.name)
                .join(", ")}
        </span>
      )}
    </Row>
  );
}

/**
 * One custom field.
 *
 * The control is chosen from the field's declared type, and a type with no
 * obvious single control renders as a value with a `title` saying why — the
 * server decided which those are, so this component cannot disagree with the
 * list the page was built from.
 */
function CustomFieldRow({
  taskId,
  field,
  canEdit,
  act,
}: {
  taskId: string;
  field: DetailField;
  canEdit: boolean;
  act: (action: () => Promise<Operation[]>) => void;
}) {
  const write = (value: unknown) => act(() => setCustomFieldValue(taskId, field.fieldId, value));

  if (!canEdit || field.editable === "read-only") {
    return (
      <Row label={field.name}>
        <span title={field.reason} data-muted={field.editable === "read-only" || undefined}>
          {display(field)}
        </span>
      </Row>
    );
  }

  switch (field.type) {
    case "checkbox":
      return (
        <Row label={field.name}>
          <input
            type="checkbox"
            checked={field.value === true}
            onChange={(event) => write(event.target.checked)}
          />
        </Row>
      );

    case "date":
      return (
        <Row label={field.name}>
          <input
            type="date"
            defaultValue={typeof field.value === "string" ? field.value.slice(0, 10) : ""}
            onBlur={(event) => write(event.target.value === "" ? null : event.target.value)}
          />
        </Row>
      );

    case "drop_down": {
      const options = (field.typeConfig.options ?? []) as { id: string; name: string }[];
      return (
        <Row label={field.name}>
          <select
            value={typeof field.value === "string" ? field.value : ""}
            onChange={(event) => write(event.target.value === "" ? null : event.target.value)}
          >
            <option value="">—</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </Row>
      );
    }

    case "number":
    case "currency":
    case "rating":
      return (
        <Row label={field.name}>
          <input
            type="number"
            defaultValue={field.value === null ? "" : String(field.value)}
            onBlur={(event) => write(event.target.value === "" ? null : Number(event.target.value))}
          />
        </Row>
      );

    case "text":
      return (
        <Row label={field.name}>
          <textarea
            rows={3}
            defaultValue={typeof field.value === "string" ? field.value : ""}
            onBlur={(event) => write(event.target.value === "" ? null : event.target.value)}
          />
        </Row>
      );

    default:
      return (
        <Row label={field.name}>
          <input
            type={field.type === "email" ? "email" : field.type === "url" ? "url" : "text"}
            defaultValue={typeof field.value === "string" ? field.value : ""}
            onBlur={(event) => write(event.target.value === "" ? null : event.target.value)}
          />
        </Row>
      );
  }
}

function display(field: DetailField): string {
  if (field.value === null || field.value === undefined || field.value === "") return "—";
  if (field.type === "checkbox") return field.value === true ? "Yes" : "No";

  if (field.type === "drop_down" || field.type === "labels") {
    const options = (field.typeConfig.options ?? []) as { id: string; name: string }[];
    const ids = Array.isArray(field.value) ? field.value : [field.value];
    const names = ids
      .map((id) => options.find((option) => option.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    return names.length > 0 ? names.join(", ") : "—";
  }

  if (Array.isArray(field.value)) return field.value.length === 0 ? "—" : field.value.join(", ");
  return String(field.value);
}
