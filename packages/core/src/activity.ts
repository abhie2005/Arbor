/**
 * Turning activity rows into the sentence a watcher reads.
 *
 * **The read-time half of the notifications design.** Direct signals — assigned,
 * mentioned, replied — get a row written for the person named, because there
 * are few of them and each is addressed to someone (`notifications.ts`).
 * Everything else is ambient: a task with two hundred watchers would otherwise
 * write two hundred rows every time somebody moved its due date. So nothing is
 * written, and what a watcher sees is assembled when they look.
 *
 * Which means the summary cannot be stored the way a notification's `payload`
 * is. It has to be derived from a group of rows, and it is derived *here* — a
 * pure function over what the query counted — for the same reason `recipientsFor`
 * is pure: the rule is small, easy to get subtly wrong, and invisible when it is.
 */

/** One activity row, reduced to what a summary needs. */
export interface ActivityChange {
  /** e.g. "task.status_changed", "comment.added". */
  verb: string;
  /** The column an update touched, when the verb is a field change. */
  field: string | null;
}

/**
 * Verbs that are movement rather than news.
 *
 * A drag writes a position; adding yourself as a watcher writes a watcher. Both
 * are real events and belong in the log — a watcher does not need to be told
 * about either, and a task that appears in the inbox saying "Riley changed
 * order" teaches people to ignore the inbox.
 *
 * Exported because the query filters on it: a task whose only activity is noise
 * should not reach the summariser at all, or it would be listed with nothing to
 * say about itself.
 */
export const AMBIENT_NOISE = [
  "task.position_changed",
  "task.watcher_added",
  "task.watcher_removed",
] as const;

/**
 * Field labels, in the words the panel uses.
 *
 * Keyed on the **column name**, because that is what the log holds: an activity
 * row's `field` is the SQL column an operation wrote (`status_id`), not the
 * operation's own camel-cased name for it (`statusId`). Getting that backwards
 * is silent — every lookup misses, and the fallback prints `status_id` at
 * people, which reads like a leak rather than a label.
 */
const FIELD_LABELS: Record<string, string> = {
  name: "the name",
  status_id: "status",
  priority: "priority",
  due_at: "due date",
  start_at: "start date",
  points: "points",
  time_estimate_ms: "estimate",
  parent_task_id: "parent",
  home_list_id: "list",
  task_type_id: "type",
};

/**
 * Verbs that say the whole thing themselves.
 *
 * A field change contributes a noun ("status") to a shared "changed …" clause;
 * these contribute a verb phrase of their own, because "changed a comment" is
 * not what happened.
 */
const VERB_PHRASES: Record<string, string> = {
  "comment.added": "commented",
  "comment.edited": "edited a comment",
  "comment.deleted": "deleted a comment",
  "comment.restored": "restored a comment",
  "task.created": "created it",
  "task.archived": "archived it",
  "task.restored": "restored it",
  "task.description_changed": "rewrote the description",
};

/**
 * Verbs that name a *thing that changed* rather than an act.
 *
 * They join the shared "changed …" clause instead of standing alone, because
 * two clauses that both begin with the same verb read as a list that forgot it
 * was a list: "changed a custom field and changed type". Adding and removing an
 * assignee are one entry here for the same reason — a watcher is being told the
 * assignees moved, not audited on the order it happened in.
 */
const VERB_NOUNS: Record<string, string> = {
  "task.custom_field_changed": "a custom field",
  "task.assignee_added": "assignees",
  "task.assignee_removed": "assignees",
  "task.tag_added": "tags",
  "task.tag_removed": "tags",
};

/**
 * "Riley Kaur and Jordan Diaz", "Riley Kaur, Sam Petrov and 2 others".
 *
 * Lives here rather than beside its first caller because the comment thread and
 * the inbox both need it — the second copy is where a helper stops being local
 * (the shell's lesson, learned at six copies rather than two).
 */
export function sentenceList(items: readonly string[], max = 3): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;

  if (items.length > max) {
    const rest = items.length - max;
    return `${items.slice(0, max).join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
  }

  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * What happened, in one clause.
 *
 * `total` is the number of rows the group actually held, which can exceed the
 * changes passed in — the query samples distinct kinds rather than dragging
 * every row of a busy week into the page. When nothing in the sample can be
 * named, the count is the honest answer.
 */
export function summarizeChanges(changes: readonly ActivityChange[], total: number): string {
  const phrases: string[] = [];
  const fields: string[] = [];

  for (const change of changes) {
    // The verb decides, always. `field` is whatever the operation had to record
    // to be undoable — a column for a field change, but a *comment id* for a
    // comment and a custom field's id for a custom field. Reading it without
    // asking the verb first is how a uuid ends up in a sentence.
    const phrase = VERB_PHRASES[change.verb];
    if (phrase) {
      if (!phrases.includes(phrase)) phrases.push(phrase);
      continue;
    }

    const noun = VERB_NOUNS[change.verb];
    if (noun) {
      if (!fields.includes(noun)) fields.push(noun);
      continue;
    }

    if (!change.field) continue;

    // A field change: the noun goes into the shared "changed …" clause.
    const label = FIELD_LABELS[change.field] ?? change.field;
    if (!fields.includes(label)) fields.push(label);
  }

  if (fields.length > 0) {
    // Three names then a count. The list is a glance, not an inventory — and
    // the task is one click away for anyone who wants the rest.
    phrases.push(`changed ${sentenceList(fields)}`);
  }

  if (phrases.length === 0) {
    return `made ${total} change${total === 1 ? "" : "s"}`;
  }

  return sentenceList(phrases, phrases.length);
}

/**
 * The whole line: who, and what.
 *
 * Deliberately not "Riley Kaur changed status on ENG-402" — the task is the
 * row's own subject and is rendered beneath, exactly as a direct notification's
 * summary leaves it out.
 */
export function summarizeAmbient(input: {
  actors: readonly string[];
  changes: readonly ActivityChange[];
  total: number;
}): string {
  const who = input.actors.length > 0 ? sentenceList(input.actors) : "Someone";
  return `${who} ${summarizeChanges(input.changes, input.total)}`;
}
