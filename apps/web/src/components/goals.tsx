"use client";

import { KEY_RESULT_KINDS, type KeyResultKind } from "@arbor/core";
import type { GoalRecord, KeyResultRecord } from "@arbor/db";
import { useEffect, useState, useTransition } from "react";

import {
  addGoalKeyResult,
  createWorkspaceGoal,
  removeGoal,
  removeKeyResult,
  renameGoal,
  setGoalComplete,
  setGoalDue,
  setGoalOwner,
  setKeyResultValue,
  type RollupMetric,
} from "@/server/goal-actions";
import type { GoalScope } from "@/server/goals";

import { useServerValue } from "./use-server-value";

/**
 * Goals, and the key results that give them meaning.
 *
 * **A rollup is a number nobody typed.** Its row has no input, because the
 * value is derived from a filter at read time and a box that appeared editable
 * and silently did nothing would be worse than a value that says where it came
 * from — the same rule as the table's unsortable headers (D-065). It says what
 * it counts instead.
 *
 * **The bar goes past full.** Passing a target is the most interesting thing a
 * key result can do, so the fill is clamped and the colour is not: over is a
 * different colour, not a bar that stops.
 */

const KIND_LABELS: Record<KeyResultKind, string> = {
  number: "Number",
  currency: "Currency",
  boolean: "Yes / no",
  rollup: "Counted from tasks",
};

const METRIC_LABELS: Record<RollupMetric, string> = {
  tasks: "Tasks",
  completed: "Tasks done",
  points: "Story points",
  estimate: "Estimated time",
};

/**
 * Running a goal action.
 *
 * Deliberately not `useTaskAction`: these return nothing to push onto the undo
 * stack, because a goal is configuration rather than task data and ⌘Z does not
 * reach it, the same as it does not reach a status set (D-103). What is kept is
 * the half that matters on screen — a transition, and a failure that is shown
 * rather than swallowed.
 */
function useGoalAction() {
  const [pending, startTransition] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!failure) return;
    const timer = setTimeout(() => setFailure(null), 4000);
    return () => clearTimeout(timer);
  }, [failure]);

  function run(action: () => Promise<unknown>) {
    startTransition(async () => {
      try {
        await action();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "That change did not save");
      }
    });
  }

  return { run, pending, failure };
}

export function Goals({
  goals,
  people,
  scopes,
  viewerId,
  canCreate,
  isAdmin,
}: {
  goals: GoalRecord[];
  people: { id: string; name: string }[];
  scopes: GoalScope[];
  viewerId: string;
  canCreate: boolean;
  isAdmin: boolean;
}) {
  const { run, pending, failure } = useGoalAction();

  return (
    <div className="goals" data-pending={pending || undefined}>
      {failure ? (
        <p className="detail-error" role="alert">
          {failure}
        </p>
      ) : null}

      {canCreate ? <NewGoal run={run} /> : null}

      {goals.length === 0 ? (
        <p className="goals-empty">
          No goals yet. A goal is a name and a date; the meaning is in its key results.
        </p>
      ) : null}

      {goals.map((goal) => (
        <GoalCard
          key={goal.id}
          goal={goal}
          people={people}
          scopes={scopes}
          // Owner or admin (D-103). Blunt, and blunt in the safe direction.
          canEdit={goal.ownerId === viewerId || isAdmin}
          run={run}
        />
      ))}
    </div>
  );
}

function NewGoal({ run }: { run: (action: () => Promise<unknown>) => void }) {
  const [name, setName] = useState("");
  const [due, setDue] = useState("");

  const submit = () => {
    if (!name.trim()) return;
    run(() => createWorkspaceGoal(name, due || null));
    setName("");
    setDue("");
  };

  return (
    <div className="goal-new">
      <input
        type="text"
        placeholder="What are you aiming at?"
        aria-label="Goal name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />
      <input
        type="date"
        aria-label="Due date"
        value={due}
        onChange={(event) => setDue(event.target.value)}
      />
      <button type="button" onClick={submit} disabled={!name.trim()}>
        Add goal
      </button>
    </div>
  );
}

function GoalCard({
  goal,
  people,
  scopes,
  canEdit,
  run,
}: {
  goal: GoalRecord;
  people: { id: string; name: string }[];
  scopes: GoalScope[];
  canEdit: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [focused, setFocused] = useState(false);
  const [name, setName] = useServerValue(goal.name, focused);

  const done = goal.completedAt !== null;

  return (
    <section className="goal" data-done={done || undefined}>
      <div className="goal-head">
        <button
          type="button"
          className="goal-check"
          aria-label={done ? `Reopen ${goal.name}` : `Mark ${goal.name} done`}
          disabled={!canEdit}
          onClick={() => run(() => setGoalComplete(goal.id, !done))}
        >
          {done ? "✓" : "○"}
        </button>

        {canEdit ? (
          <input
            className="goal-title"
            value={name}
            aria-label="Goal name"
            onChange={(event) => setName(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (name.trim() && name !== goal.name) run(() => renameGoal(goal.id, name));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setName(goal.name);
                event.currentTarget.blur();
              }
            }}
          />
        ) : (
          <h2 className="goal-title-static">{name}</h2>
        )}

        <GoalProgress progress={goal.progress} />

        {canEdit ? (
          <button
            type="button"
            className="goal-delete"
            aria-label={`Delete ${goal.name}`}
            onClick={() => run(() => removeGoal(goal.id))}
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="goal-meta">
        {/* The owner is on the same row as the number, because the number is
            computed as them (D-102) — whose view it is, is on screen. */}
        <label>
          Owner
          {canEdit ? (
            <select
              value={goal.ownerId ?? ""}
              onChange={(event) => run(() => setGoalOwner(goal.id, event.target.value))}
            >
              {goal.ownerId === null ? <option value="">Nobody</option> : null}
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{goal.ownerName ?? "Nobody"}</span>
          )}
        </label>

        <label>
          Due
          {canEdit ? (
            <input
              type="date"
              value={goal.dueAt ? goal.dueAt.slice(0, 10) : ""}
              onChange={(event) => run(() => setGoalDue(goal.id, event.target.value || null))}
            />
          ) : (
            <span>{goal.dueAt ? goal.dueAt.slice(0, 10) : "—"}</span>
          )}
        </label>
      </div>

      {goal.keyResults.length === 0 ? (
        <p className="goal-empty">
          No key results yet — so there is nothing to measure this by.
        </p>
      ) : (
        <ul className="kr-list">
          {goal.keyResults.map((kr) => (
            <KeyResultRow key={kr.id} kr={kr} canEdit={canEdit} run={run} />
          ))}
        </ul>
      )}

      {canEdit ? (
        adding ? (
          <NewKeyResult
            goalId={goal.id}
            scopes={scopes}
            run={run}
            done={() => setAdding(false)}
          />
        ) : (
          <button type="button" className="kr-add" onClick={() => setAdding(true)}>
            Add key result
          </button>
        )
      ) : null}
    </section>
  );
}

function GoalProgress({ progress }: { progress: number | null }) {
  // Null is a real answer: a goal with no key results is a title, and a bar at
  // zero would be a claim that nothing had happened.
  if (progress === null) return <span className="goal-percent goal-percent-none">not measured</span>;
  return <span className="goal-percent">{Math.round(progress * 100)}%</span>;
}

function KeyResultRow({
  kr,
  canEdit,
  run,
}: {
  kr: KeyResultRecord;
  canEdit: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useServerValue(kr.current === null ? "" : String(kr.current), focused);

  const percent = kr.progress === null ? null : kr.progress * 100;
  const derived = kr.kind === "rollup";

  return (
    <li className="kr" data-unmeasured={kr.unmeasured ? "true" : undefined}>
      <span className="kr-name">{kr.name}</span>

      <span className="kr-bar">
        <span className="kr-bar-track">
          <span
            className="kr-bar-fill"
            data-over={percent !== null && percent > 100 ? "true" : undefined}
            style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }}
          />
        </span>
      </span>

      <span className="kr-value">
        {derived || kr.kind === "boolean" || !canEdit ? (
          <span className="kr-current">{kr.currentLabel}</span>
        ) : (
          <input
            className="kr-input"
            type="number"
            aria-label={`Current value for ${kr.name}`}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => {
              setFocused(false);
              if (value !== String(kr.current ?? "")) {
                run(() => setKeyResultValue(kr.id, value));
              }
            }}
          />
        )}
        <span className="kr-target">of {kr.targetLabel}</span>
      </span>

      {kr.kind === "boolean" && canEdit ? (
        <button
          type="button"
          className="kr-toggle"
          onClick={() => run(() => setKeyResultValue(kr.id, kr.current ? "false" : "true"))}
        >
          {kr.current ? "Undo" : "Done"}
        </button>
      ) : null}

      {/* Why a rollup has no number, when it has none. Said rather than left as
          a dash, because "not measured" and "measured as nothing" look the same
          and are not. */}
      {kr.unmeasured ? <span className="kr-why">{kr.unmeasured}</span> : null}

      {canEdit ? (
        <button
          type="button"
          className="kr-delete"
          aria-label={`Delete ${kr.name}`}
          onClick={() => run(() => removeKeyResult(kr.id))}
        >
          ×
        </button>
      ) : null}
    </li>
  );
}

/**
 * The form for a new key result.
 *
 * The rollup half offers four metrics and a container, which is a subset of
 * what `source` can hold — the column carries a whole view definition (D-101),
 * so the generality is in the data rather than in this form. A future filter
 * builder writes richer definitions with no migration; a form that covered
 * every case would be the filter bar again.
 */
function NewKeyResult({
  goalId,
  scopes,
  run,
  done,
}: {
  goalId: string;
  scopes: GoalScope[];
  run: (action: () => Promise<unknown>) => void;
  done: () => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<KeyResultKind>("rollup");
  const [start, setStart] = useState("0");
  const [target, setTarget] = useState("10");
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");
  const [metric, setMetric] = useState<RollupMetric>("completed");

  const submit = () => {
    if (!name.trim()) return;
    const scope = scopes.find((candidate) => candidate.id === scopeId);

    run(() =>
      addGoalKeyResult(goalId, {
        name,
        kind,
        start,
        target,
        scopeId: scope?.id,
        scopeKind: scope?.kind,
        metric,
      }),
    );
    done();
  };

  return (
    <div className="kr-new">
      <input
        type="text"
        placeholder="What has to be true?"
        aria-label="Key result name"
        value={name}
        onChange={(event) => setName(event.target.value)}
      />

      <select
        aria-label="What kind of key result"
        value={kind}
        onChange={(event) => setKind(event.target.value as KeyResultKind)}
      >
        {KEY_RESULT_KINDS.map((candidate) => (
          <option key={candidate} value={candidate}>
            {KIND_LABELS[candidate]}
          </option>
        ))}
      </select>

      {kind === "rollup" ? (
        <>
          <select
            aria-label="What to count"
            value={metric}
            onChange={(event) => setMetric(event.target.value as RollupMetric)}
          >
            {(Object.keys(METRIC_LABELS) as RollupMetric[]).map((candidate) => (
              <option key={candidate} value={candidate}>
                {METRIC_LABELS[candidate]}
              </option>
            ))}
          </select>

          <select
            aria-label="Where to count it"
            value={scopeId}
            onChange={(event) => setScopeId(event.target.value)}
          >
            {scopes.map((scope) => (
              <option key={scope.id} value={scope.id}>
                {scope.name}
              </option>
            ))}
          </select>
        </>
      ) : null}

      {kind === "boolean" ? null : (
        <>
          <input
            type="number"
            aria-label="Starting value"
            title="Starting value"
            value={start}
            onChange={(event) => setStart(event.target.value)}
          />
          <span className="kr-arrow">→</span>
          <input
            type="number"
            aria-label="Target value"
            title="Target value"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        </>
      )}

      <button type="button" onClick={submit} disabled={!name.trim()}>
        Add
      </button>
      <button type="button" onClick={done}>
        Cancel
      </button>
    </div>
  );
}
