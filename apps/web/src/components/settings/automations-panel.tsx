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
  setAutomationEnabledAction,
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

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDeleting(null);
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

                      <span className="automation-name">{rule.name}</span>

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

            <NewAutomation
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
  const label = RUN_LABELS[run.status] ?? run.status;
  const tone = run.status === "failed" ? "warn" : run.status === "success" ? "" : "quiet";

  return (
    <span
      className={`settings-badge ${tone}`.trim()}
      title={run.error ?? (run.attempts > 1 ? `${run.attempts} attempts` : undefined) ?? undefined}
    >
      {label} <Timestamp at={run.status === "pending" ? run.runAfter : run.startedAt} />
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

function NewAutomation({
  containerId,
  fields,
  values,
  names,
  onSave,
}: {
  containerId: string;
  fields: FilterableField[];
  values: FilterOptionValues;
  names: (input: ValueInput, value: unknown) => string;
  onSave: (input: {
    containerId: string;
    name: string;
    trigger: unknown;
    conditions?: unknown;
    actions: unknown;
    appliesTo?: string;
    delaySeconds?: number;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [triggerKind, setTriggerKind] = useState<AutomationTrigger["kind"]>("fieldChanged");
  const [watched, setWatched] = useState<TaskField>("statusId");
  const [narrowed, setNarrowed] = useState(true);
  const [becomes, setBecomes] = useState<unknown>(() => firstValueFor("statusId", values));
  const [relation, setRelation] = useState<RelationKind>("assignee");
  const [target, setTarget] = useState<string>("");
  const [conditions, setConditions] = useState<FilterGroup>({ op: "AND", conditions: [] });
  const [actions, setActions] = useState<DraftAction[]>([() => draftAction(values)].map((f) => f()));
  const [appliesTo, setAppliesTo] = useState<AppliesTo>("tasks");
  const [delaySeconds, setDelaySeconds] = useState(0);

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
    setNarrowed(true);
    setBecomes(firstValueFor("statusId", values));
    setRelation("assignee");
    setTarget("");
    setConditions({ op: "AND", conditions: [] });
    setActions([draftAction(values)]);
    setAppliesTo("tasks");
    setDelaySeconds(0);
  }

  const watchedField = AUTOMATABLE_FIELDS.find((candidate) => candidate.field === watched)!;
  const needs = AUTOMATION_TRIGGERS.find((candidate) => candidate.kind === triggerKind)!.needs;

  const trigger = buildTrigger({ triggerKind, watched, narrowed, becomes, relation, target });
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
      <h3 className="settings-heading">New rule</h3>

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
                // build a rule that stores a status id in a date.
                setBecomes(firstValueFor(next, values));
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
              value={narrowed ? "to" : "any"}
              onChange={(event) => setNarrowed(event.target.value === "to")}
            >
              <option value="to">becomes</option>
              <option value="any">changes at all</option>
            </select>

            {narrowed ? (
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
            reset();
          }}
        >
          Add rule
        </button>
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

function buildTrigger({
  triggerKind,
  watched,
  narrowed,
  becomes,
  relation,
  target,
}: {
  triggerKind: AutomationTrigger["kind"];
  watched: TaskField;
  narrowed: boolean;
  becomes: unknown;
  relation: RelationKind;
  target: string;
}): AutomationTrigger {
  if (triggerKind === "fieldChanged") {
    // `to` is omitted rather than set to null when the rule is not narrowed:
    // the parser tests for the key's presence, and `to: null` is the rule "when
    // the status becomes empty", which is a different rule.
    return narrowed
      ? { kind: "fieldChanged", field: watched, to: becomes }
      : { kind: "fieldChanged", field: watched };
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
