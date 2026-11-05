"use client";

import {
  type AppliesTo,
  type AutomationAction,
  type AutomationRule,
  type AutomationTrigger,
  type FilterGroup,
  type FilterableField,
  type RelationKind,
  type TaskField,
  type ValueInput,
  APPLIES_TO_LABELS,
  AUTOMATABLE_FIELDS,
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  DELAY_CHOICES,
  RELATION_LABELS,
  describeDelay,
  describeRule,
  mayRetry,
  relationInput,
} from "@arbor/core";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  type FilterOptionValues,
  ConditionEditor,
  ValueControl,
  defaultValueFor,
  optionsFor,
} from "@/components/filter-conditions";
import { Timestamp } from "@/components/timestamp";
import {
  createAutomationAction,
  deleteAutomationAction,
  renameAutomationAction,
  setAutomationEnabledAction,
  updateAutomationAction,
} from "@/server/automation-actions";

/**
 * Rules in one container, and the form that writes one.
 *
 * **Every menu here comes from a declaration the server validates against** —
 * `AUTOMATION_TRIGGERS`, `AUTOMATION_ACTIONS` and `AUTOMATABLE_FIELDS` in
 * `@arbor/core`, which `parseAutomationRule` is unit-tested against. So the
 * failure this screen cannot have is the one the filter bar also cannot have:
 * building something, saving it, and being told it was never possible.
 *
 * **The sentence under each rule is `describeRule`**, the same function the
 * form previews with. A list and a preview that phrased a rule differently
 * would be two accounts of what is about to happen, and the one on the form is
 * the only one anybody reads before saving.
 */

export interface RuleContainer {
  id: string;
  name: string;
  kind: "space" | "folder" | "list";
  depth: number;
}

export interface RunSummary {
  status: string;
  error: string | null;
  attempts: number;
  startedAt: string;
  finishedAt: string | null;
  runAfter: string;
}

export interface AutomationRow {
  id: string;
  name: string;
  /** Null when the stored rule no longer parses — `problem` then says why. */
  rule: AutomationRule | null;
  problem: string | null;
  isEnabled: boolean;
  createdAt: string;
  createdByName: string | null;
  runs: { total: number; failed: number; pending: number };
  lastRun: RunSummary | null;
}

export function AutomationsPanel({
  containers,
  selected,
  rules,
  fields,
  values,
  quota,
}: {
  containers: RuleContainer[];
  selected: RuleContainer | null;
  rules: AutomationRow[];
  fields: FilterableField[];
  values: FilterOptionValues;
  quota: { used: number; quota: number; refused: number };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  /**
   * Two pieces of state rather than one `mode`, because they are two different
   * edits (D-140): a name can be changed on a rule nobody can parse, and the
   * rule itself cannot.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(null);
      setRenaming(null);
      setEditing(null);
      router.refresh();
    });
  }

  const names = nameLookup(values);
  const share = quota.quota > 0 ? quota.used / quota.quota : 0;

  return (
    <div className="automations" data-pending={pending || undefined}>
      <div className="sharing-tree">
        {containers.map((container) => (
          <a
            key={container.id}
            className="sharing-node"
            style={{ paddingLeft: `calc(var(--space-3) + ${container.depth} * 14px)` }}
            href={`/settings/automations?container=${container.id}`}
            aria-current={container.id === selected?.id ? "page" : undefined}
          >
            <span className="sharing-kind">
              {container.kind === "space" ? "◈" : container.kind === "folder" ? "▸" : "▤"}
            </span>
            {container.name}
          </a>
        ))}
      </div>

      <div className="sharing-detail">
        {!selected ? (
          <p className="settings-note">
            Automations are written on a container you manage. Nothing here can be automated by you
            yet.
          </p>
        ) : (
          <>
            <h3>{selected.name}</h3>

            {/* The quota has been counted since the engine was built and said
                nowhere: a workspace that reached it got `refused_quota` rows
                and no warning. */}
            <p className="automation-quota" data-warn={share >= 0.8 || undefined}>
              {quota.used} of {quota.quota} runs used this month
              {quota.refused > 0 ? (
                <strong> — {quota.refused} refused for being over it</strong>
              ) : null}
            </p>

            <div className="automation-list">
              {rules.length === 0 ? (
                <p className="settings-note">No rules here yet.</p>
              ) : (
                rules.map((rule) => (
                  <div className="automation-row" key={rule.id} data-off={!rule.isEnabled || undefined}>
                    <div className="automation-head">
                      <label className="automation-switch" title="Enabled">
                        {/* No local copy of a server value (invariant 11): the
                            checkbox reads the prop, and the refresh after the
                            action is what moves it. */}
                        <input
                          type="checkbox"
                          checked={rule.isEnabled}
                          onChange={() =>
                            run(() => setAutomationEnabledAction(rule.id, !rule.isEnabled))
                          }
                        />
                      </label>

                      {renaming === rule.id ? (
                        // A rename is its own entry point and works on a rule
                        // the parser cannot read, which is the one most in
                        // need of a label before somebody fixes it (D-140).
                        <RenameRule
                          name={rule.name}
                          onSave={(next) => run(() => renameAutomationAction(rule.id, next))}
                          onCancel={() => setRenaming(null)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="automation-name"
                          title="Rename"
                          onClick={() => {
                            setEditing(null);
                            setRenaming(rule.id);
                          }}
                        >
                          {rule.name}
                        </button>
                      )}

                      {rule.rule ? (
                        <span className="settings-badge quiet">
                          {APPLIES_TO_LABELS[rule.rule.appliesTo]}
                        </span>
                      ) : null}

                      {rule.rule && rule.rule.delaySeconds > 0 ? (
                        <span className="settings-badge quiet">
                          {describeDelay(rule.rule.delaySeconds)}
                        </span>
                      ) : null}

                      <RunBadge rule={rule} />

                      {/* A rule that no longer parses has nothing to seed a
                          form with, so there is no edit button on one — rename
                          and delete are what it offers, which is the same
                          reason the sentence below it is shown rather than
                          hidden. */}
                      {rule.rule ? (
                        <button
                          type="button"
                          className="settings-icon"
                          title="Edit"
                          aria-label={`Edit ${rule.name}`}
                          onClick={() => {
                            setRenaming(null);
                            setDeleting(null);
                            setEditing(editing === rule.id ? null : rule.id);
                          }}
                        >
                          ✎
                        </button>
                      ) : null}

                      <button
                        type="button"
                        className="settings-icon danger"
                        title="Delete"
                        onClick={() => setDeleting(deleting === rule.id ? null : rule.id)}
                      >
                        ×
                      </button>
                    </div>

                    <p className="automation-sentence">
                      {rule.rule ? (
                        describeRule(rule.rule, names)
                      ) : (
                        // Shown rather than hidden: the engine skips a rule it
                        // cannot parse, and a rule nobody can see is a rule
                        // nobody can delete.
                        <span className="automation-broken">
                          This rule can no longer be read: {rule.problem}
                        </span>
                      )}
                    </p>

                    <p className="automation-meta">
                      {rule.runs.total} run{rule.runs.total === 1 ? "" : "s"}
                      {rule.runs.failed > 0 ? `, ${rule.runs.failed} failed` : ""}
                      {rule.runs.pending > 0 ? `, ${rule.runs.pending} waiting` : ""} · added{" "}
                      <Timestamp at={rule.createdAt} /> by {rule.createdByName ?? "somebody since removed"}
                    </p>

                    {editing === rule.id && rule.rule ? (
                      <AutomationForm
                        containerId={selected.id}
                        fields={fields}
                        values={values}
                        names={names}
                        initial={{ name: rule.name, rule: rule.rule }}
                        onSave={(input) => run(() => updateAutomationAction(rule.id, input))}
                        onCancel={() => setEditing(null)}
                      />
                    ) : null}

                    {deleting === rule.id ? (
                      <div className="settings-confirm">
                        <span>
                          Delete this rule? Its{" "}
                          {rule.runs.total === 1 ? "1 run goes" : `${rule.runs.total} runs go`} with
                          it, and anything already written stays.
                        </span>
                        <button
                          type="button"
                          className="settings-danger"
                          onClick={() => run(() => deleteAutomationAction(rule.id))}
                        >
                          Delete
                        </button>
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
                ))
              )}
            </div>

            <AutomationForm
              key={selected.id}
              containerId={selected.id}
              fields={fields}
              values={values}
              names={names}
              onSave={(input) => run(() => createAutomationAction(input))}
            />
          </>
        )}

        {error ? (
          <p className="settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * What happened last, in the vocabulary of the thing that happened.
 *
 * A skipped run is not a failure and must not read as one: `skipped_self` is
 * the cycle guard doing its job, and `skipped_conditions` is a rule that fired
 * and correctly decided to do nothing. Showing them all as "did not run" is how
 * somebody ends up debugging an engine that is working.
 */
function RunBadge({ rule }: { rule: AutomationRow }) {
  if (!rule.lastRun) return <span className="settings-badge quiet">never run</span>;

  const run = rule.lastRun;
  const tone = run.status === "failed" ? "warn" : run.status === "success" ? "" : "quiet";

  /**
   * A failure that will be tried again is a different fact from one that will
   * not, and the badge used to print both as "failed" with the attempt count
   * hidden in a `title` (D-145). "failed, trying again" is the one somebody can
   * wait out; "failed, gave up after 3" is the one that needs them.
   *
   * It reads `attempts` against the same `MAX_RUN_ATTEMPTS` the claim does
   * rather than a number typed in here, so the sentence cannot drift from the
   * behaviour it describes.
   */
  const label =
    run.status === "failed"
      ? mayRetry(run.attempts)
        ? "failed, trying again"
        : `failed, gave up after ${run.attempts}`
      : (RUN_LABELS[run.status] ?? run.status);

  return (
    <span
      className={`settings-badge ${tone}`.trim()}
      title={run.error ?? (run.attempts > 1 ? `${run.attempts} attempts` : undefined) ?? undefined}
    >
      {label}{" "}
      <Timestamp
        at={
          run.status === "pending" || (run.status === "failed" && mayRetry(run.attempts))
            ? run.runAfter
            : run.startedAt
        }
      />
    </span>
  );
}

const RUN_LABELS: Record<string, string> = {
  success: "ran",
  failed: "failed",
  pending: "acts",
  skipped_conditions: "conditions did not match",
  skipped_self: "skipped its own change",
  refused_depth: "refused, too deep",
  refused_quota: "refused, over quota",
};

/** An action being built, before the keys its kind does not use are dropped. */
interface DraftAction {
  kind: AutomationAction["kind"];
  field: TaskField;
  to: unknown;
  relation: RelationKind;
  targetId: string;
  text: string;
}

/**
 * One form for writing a rule and for changing one (D-140).
 *
 * Editing seeds the same eleven pieces of state from an existing rule rather
 * than duplicating the form, because a second form is a second place for the
 * menus to drift from the compiler's own declaration — which is the whole
 * reason `filter-conditions.tsx` was extracted in D-129.
 *
 * `initial` is a *rule*, not a row: the form has no business knowing an id, so
 * which action a save calls stays the parent's decision.
 */
function AutomationForm({
  containerId,
  fields,
  values,
  names,
  initial,
  onSave,
  onCancel,
}: {
  containerId: string;
  fields: FilterableField[];
  values: FilterOptionValues;
  names: (input: ValueInput, value: unknown) => string;
  initial?: { name: string; rule: AutomationRule };
  onSave: (input: {
    containerId: string;
    name: string;
    trigger: unknown;
    conditions?: unknown;
    actions: unknown;
    appliesTo?: string;
    delaySeconds?: number;
  }) => void;
  onCancel?: () => void;
}) {
  const seed = initial ? triggerParts(initial.rule.trigger, values) : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger["kind"]>(
    seed?.triggerKind ?? "fieldChanged",
  );
  const [watched, setWatched] = useState<TaskField>(seed?.watched ?? "statusId");
  /**
   * Four shapes, not two (D-141). The engine has always matched on `from` as
   * well as `to` and `describeRule` has always printed it; only the form was
   * missing it, so "when the status stops being Blocked" was expressible
   * everywhere except where somebody would write it.
   */
  const [narrowing, setNarrowing] = useState<Narrowing>(seed?.narrowing ?? "to");
  const [becomes, setBecomes] = useState<unknown>(
    () => seed?.becomes ?? firstValueFor("statusId", values),
  );
  const [was, setWas] = useState<unknown>(() => seed?.was ?? firstValueFor("statusId", values));
  const [relation, setRelation] = useState<RelationKind>(seed?.relation ?? "assignee");
  const [target, setTarget] = useState<string>(seed?.target ?? "");
  const [conditions, setConditions] = useState<FilterGroup>(
    initial?.rule.conditions ?? { op: "AND", conditions: [] },
  );
  const [actions, setActions] = useState<DraftAction[]>(() =>
    initial ? draftsFrom(initial.rule.actions, values) : [draftAction(values)],
  );
  const [appliesTo, setAppliesTo] = useState<AppliesTo>(initial?.rule.appliesTo ?? "tasks");
  const [delaySeconds, setDelaySeconds] = useState(initial?.rule.delaySeconds ?? 0);
  const editing = initial !== undefined;

  /**
   * Back to an empty form after a save.
   *
   * All of it, not the half a rule's *name* obviously belongs to: leaving the
   * trigger and the delay behind means the next rule starts as a partial copy
   * of the last one, and a form that is half-filled with somebody else's
   * answers is how a rule gets saved with a clause nobody read.
   */
  function reset() {
    setName("");
    setTriggerKind("fieldChanged");
    setWatched("statusId");
    setNarrowing("to");
    setBecomes(firstValueFor("statusId", values));
    setWas(firstValueFor("statusId", values));
    setRelation("assignee");
    setTarget("");
    setConditions({ op: "AND", conditions: [] });
    setActions([draftAction(values)]);
    setAppliesTo("tasks");
    setDelaySeconds(0);
  }

  const watchedField = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === watched)!;
  const needs = AUTOMATION_TRIGGERS.find((candidate) => candidate.kind === triggerKind)!.needs;

  const trigger = buildTrigger({ triggerKind, watched, narrowing, becomes, was, relation, target });
  const built: AutomationRule = {
    trigger,
    conditions,
    actions: actions.map(toAction),
    appliesTo,
    delaySeconds,
  };

  // The preview is the same sentence the list shows. It can throw while the
  // form is half-built — an action with nothing chosen yet — and a preview is
  // not the place to raise that: the save is, and the server is what decides.
  let preview: string | null = null;
  try {
    preview = describeRule(built, names);
  } catch {
    preview = null;
  }

  return (
    <section className="settings-section automation-new">
      <h3 className="settings-heading">{editing ? "Edit rule" : "New rule"}</h3>

      <div className="settings-form">
        <input
          className="settings-input"
          placeholder="What this rule is for"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />

        <select
          className="settings-select"
          aria-label="Scope"
          value={appliesTo}
          onChange={(event) => setAppliesTo(event.target.value as AppliesTo)}
        >
          {Object.entries(APPLIES_TO_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="automation-clause">
        <span className="automation-word">When</span>

        <select
          aria-label="Trigger"
          value={triggerKind}
          onChange={(event) => setTriggerKind(event.target.value as AutomationTrigger["kind"])}
        >
          {AUTOMATION_TRIGGERS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </select>

        {needs === "field" ? (
          <>
            <select
              aria-label="Watched field"
              value={watched}
              onChange={(event) => {
                const next = event.target.value as TaskField;
                setWatched(next);
                // The value belongs to the field. Carrying it across would
                // build a rule that stores a status id in a date. Both ends of
                // the narrowing, not only the one currently showing.
                setBecomes(firstValueFor(next, values));
                setWas(firstValueFor(next, values));
              }}
            >
              {AUTOMATABLE_FIELDS.map((option) => (
                <option key={option.field} value={option.field}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              aria-label="Narrowing"
              value={narrowing}
              onChange={(event) => setNarrowing(event.target.value as Narrowing)}
            >
              <option value="to">becomes</option>
              <option value="from">stops being</option>
              <option value="both">changes from</option>
              <option value="any">changes at all</option>
            </select>

            {narrowing === "from" || narrowing === "both" ? (
              <ValueControl
                input={watchedField.input}
                value={was}
                values={values}
                onChange={setWas}
              />
            ) : null}

            {/* The word only belongs between two values. "becomes X" and
                "stops being X" already read as sentences. */}
            {narrowing === "both" ? <span className="automation-word">to</span> : null}

            {narrowing === "to" || narrowing === "both" ? (
              <ValueControl
                input={watchedField.input}
                value={becomes}
                values={values}
                onChange={setBecomes}
              />
            ) : null}
          </>
        ) : null}

        {needs === "relation" ? (
          <>
            <select
              aria-label="Relation"
              value={relation}
              onChange={(event) => {
                setRelation(event.target.value as RelationKind);
                setTarget("");
              }}
            >
              {Object.entries(RELATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>

            {/* "Anybody" is the absence of `targetId`, not a magic id — an
                unnarrowed relation trigger fires for everyone. */}
            <select
              aria-label="Target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            >
              <option value="">anybody</option>
              {(optionsFor(relationInput(relation), undefined, values) ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <div className="automation-clause">
        <span className="automation-word">If</span>
        {/* The filter bar's own menus. `filter-bar` is the class the chips are
            styled by; what differs is where the value is kept. */}
        <div className="filter-bar">
          <ConditionEditor
            fields={fields}
            values={values}
            group={conditions}
            onChange={setConditions}
            addLabel="+ Condition"
          />
        </div>
      </div>

      <div className="automation-clause">
        <span className="automation-word">Then</span>

        <select
          aria-label="Delay"
          value={delaySeconds}
          onChange={(event) => setDelaySeconds(Number(event.target.value))}
        >
          {DELAY_CHOICES.map((choice) => (
            <option key={choice.seconds} value={choice.seconds}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>

      <div className="automation-actions">
        {actions.map((action, index) => (
          <ActionRow
            key={index}
            action={action}
            values={values}
            onChange={(next) =>
              setActions(actions.map((current, i) => (i === index ? next : current)))
            }
            onRemove={
              actions.length > 1
                ? () => setActions(actions.filter((_, i) => i !== index))
                : undefined
            }
          />
        ))}

        <button
          type="button"
          className="settings-add"
          onClick={() => setActions([...actions, draftAction(values)])}
        >
          + Action
        </button>
      </div>

      {preview ? <p className="automation-preview">{preview}</p> : null}

      <div className="settings-form">
        <button
          type="button"
          className="settings-primary"
          disabled={!name.trim()}
          onClick={() => {
            onSave({
              containerId,
              name,
              trigger,
              conditions,
              actions: actions.map(toAction),
              appliesTo,
              delaySeconds,
            });
            // Only when writing a new one. Emptying an edit form on save would
            // blank the rule on screen for as long as the refresh takes, and
            // the parent closes it anyway.
            if (!editing) reset();
          }}
        >
          {editing ? "Save changes" : "Add rule"}
        </button>

        {onCancel ? (
          <button type="button" className="settings-quiet" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ActionRow({
  action,
  values,
  onChange,
  onRemove,
}: {
  action: DraftAction;
  values: FilterOptionValues;
  onChange: (next: DraftAction) => void;
  onRemove?: () => void;
}) {
  const needs = AUTOMATION_ACTIONS.find((candidate) => candidate.kind === action.kind)!.needs;
  const field = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === action.field)!;

  return (
    <div className="automation-action">
      <select
        aria-label="Action"
        value={action.kind}
        onChange={(event) =>
          onChange({ ...action, kind: event.target.value as AutomationAction["kind"] })
        }
      >
        {AUTOMATION_ACTIONS.map((option) => (
          <option key={option.kind} value={option.kind}>
            {option.label}
          </option>
        ))}
      </select>

      {needs === "field" ? (
        <>
          <select
            aria-label="Field to set"
            value={action.field}
            onChange={(event) => {
              const next = event.target.value as TaskField;
              onChange({ ...action, field: next, to: firstValueFor(next, values) });
            }}
          >
            {AUTOMATABLE_FIELDS.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="automation-word">to</span>
          <ValueControl
            input={field.input}
            value={action.to}
            values={values}
            onChange={(to) => onChange({ ...action, to })}
          />
        </>
      ) : null}

      {needs === "relation" ? (
        <>
          <select
            aria-label="Relation to change"
            value={action.relation}
            onChange={(event) => {
              const next = event.target.value as RelationKind;
              onChange({
                ...action,
                relation: next,
                targetId: String(defaultValueFor(relationInput(next), undefined, values) ?? ""),
              });
            }}
          >
            {Object.entries(RELATION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <ValueControl
            input={relationInput(action.relation)}
            value={action.targetId}
            values={values}
            onChange={(targetId) => onChange({ ...action, targetId: String(targetId ?? "") })}
          />
        </>
      ) : null}

      {needs === "text" ? (
        <input
          className="settings-input"
          aria-label="Comment"
          placeholder="What the automation says"
          value={action.text}
          onChange={(event) => onChange({ ...action, text: event.target.value })}
        />
      ) : null}

      {onRemove ? (
        <button type="button" className="settings-icon danger" title="Remove" onClick={onRemove}>
          ×
        </button>
      ) : null}
    </div>
  );
}

function draftAction(values: FilterOptionValues): DraftAction {
  return {
    kind: "setField",
    field: "statusId",
    to: firstValueFor("statusId", values),
    relation: "assignee",
    targetId: String(defaultValueFor("user", undefined, values) ?? ""),
    text: "",
  };
}

/** The draft, reduced to the keys its kind actually carries. */
function toAction(draft: DraftAction): AutomationAction {
  switch (draft.kind) {
    case "setField":
      return { kind: "setField", field: draft.field, to: draft.to };
    case "addRelation":
      return { kind: "addRelation", relation: draft.relation, targetId: draft.targetId };
    case "removeRelation":
      return { kind: "removeRelation", relation: draft.relation, targetId: draft.targetId };
    case "comment":
      return { kind: "comment", text: draft.text };
    default:
      return { kind: "archive" };
  }
}

/**
 * The inverse of `toAction` (D-140).
 *
 * A draft carries every key any kind could need and `toAction` narrows it to
 * the ones its kind actually uses, so coming back the other way means starting
 * from the defaults and overlaying what this action happens to hold. Anything
 * the stored action does not carry keeps its default, which is what makes
 * switching an action's kind in the form behave the same whether the rule was
 * just written or loaded.
 */
function draftsFrom(actions: AutomationAction[], values: FilterOptionValues): DraftAction[] {
  if (actions.length === 0) return [draftAction(values)];

  return actions.map((action) => {
    const draft = { ...draftAction(values), kind: action.kind };

    if (action.kind === "setField") {
      return { ...draft, field: action.field, to: action.to };
    }
    if (action.kind === "addRelation" || action.kind === "removeRelation") {
      return { ...draft, relation: action.relation, targetId: action.targetId };
    }
    if (action.kind === "comment") {
      return { ...draft, text: typeof action.text === "string" ? action.text : "" };
    }
    return draft;
  });
}

/**
 * The inverse of `buildTrigger`.
 *
 * **`narrowed` is the presence of the key, not the truthiness of the value.**
 * `buildTrigger` omits `to` rather than writing null precisely because
 * `to: null` is the different rule "when the status becomes empty" — so
 * reading it back has to ask the same question the same way, or editing a rule
 * that watches for *empty* would silently widen it to "changes at all".
 */
function triggerParts(
  trigger: AutomationTrigger,
  values: FilterOptionValues,
): {
  triggerKind: AutomationTrigger["kind"];
  watched: TaskField;
  narrowing: Narrowing;
  becomes: unknown;
  was: unknown;
  relation: RelationKind;
  target: string;
} {
  const base = {
    triggerKind: trigger.kind,
    watched: "statusId" as TaskField,
    narrowing: "to" as Narrowing,
    becomes: firstValueFor("statusId", values),
    was: firstValueFor("statusId", values),
    relation: "assignee" as RelationKind,
    target: "",
  };

  if (trigger.kind === "fieldChanged") {
    const hasTo = "to" in trigger;
    const hasFrom = "from" in trigger;
    const fallback = firstValueFor(trigger.field, values);
    return {
      ...base,
      watched: trigger.field,
      narrowing: hasFrom ? (hasTo ? "both" : "from") : hasTo ? "to" : "any",
      becomes: hasTo ? trigger.to : fallback,
      was: hasFrom ? trigger.from : fallback,
    };
  }

  if (trigger.kind === "relationAdded" || trigger.kind === "relationRemoved") {
    return { ...base, relation: trigger.relation, target: trigger.targetId ?? "" };
  }

  return base;
}

/**
 * Renaming, inline, in the row (D-140).
 *
 * Local state is correct here and is not the thing invariant 11 forbids: this
 * is text somebody is typing, not a control displaying a server value. It is
 * mounted only while renaming and unmounted on save, so there is no second
 * copy of the name to go stale.
 */
function RenameRule({
  name,
  onSave,
  onCancel,
}: {
  name: string;
  onSave: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);

  return (
    <input
      className="settings-input automation-rename"
      autoFocus
      value={draft}
      aria-label={`Rename ${name}`}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter" && draft.trim()) onSave(draft.trim());
        if (event.key === "Escape") onCancel();
      }}
      // Clicking elsewhere is a cancel rather than a save: a name half-typed
      // and abandoned should not become the rule's name because a menu stole
      // the focus.
      onBlur={onCancel}
    />
  );
}

/** Which ends of a field change the rule pins down (D-141). */
type Narrowing = "to" | "from" | "both" | "any";

function buildTrigger({
  triggerKind,
  watched,
  narrowing,
  becomes,
  was,
  relation,
  target,
}: {
  triggerKind: AutomationTrigger["kind"];
  watched: TaskField;
  narrowing: Narrowing;
  becomes: unknown;
  was: unknown;
  relation: RelationKind;
  target: string;
}): AutomationTrigger {
  if (triggerKind === "fieldChanged") {
    // A key is **omitted** rather than set to null when that end is not
    // narrowed: the parser and the matcher both test for the key's presence,
    // and `to: null` is the rule "when the status becomes empty", which is a
    // different rule. That is why this builds the object up rather than
    // spreading both values and letting undefined sort it out.
    const trigger: Extract<AutomationTrigger, { kind: "fieldChanged" }> = {
      kind: "fieldChanged",
      field: watched,
    };
    if (narrowing === "from" || narrowing === "both") trigger.from = was;
    if (narrowing === "to" || narrowing === "both") trigger.to = becomes;
    return trigger;
  }

  if (triggerKind === "relationAdded" || triggerKind === "relationRemoved") {
    return target
      ? { kind: triggerKind, relation, targetId: target }
      : { kind: triggerKind, relation };
  }

  return { kind: triggerKind } as AutomationTrigger;
}

function firstValueFor(field: TaskField, values: FilterOptionValues): unknown {
  const meta = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === field);
  return defaultValueFor(meta?.input ?? "text", undefined, values);
}

/**
 * An id to something a person recognises.
 *
 * Takes the `ValueInput` as well as the value because an id does not say which
 * table it came from — the same uuid shape is a status, a person or a list. An
 * id with no match is printed as itself rather than as "unknown": a rule
 * pointing at a deleted status should show that it does.
 */
function nameLookup(values: FilterOptionValues) {
  return (input: ValueInput, value: unknown): string => {
    if (value === null || value === undefined || value === "") return "nothing";
    const options = optionsFor(input, undefined, values);
    const match = options?.find((option) => String(option.id) === String(value));
    return match?.name ?? String(value);
  };
}
