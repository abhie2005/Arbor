/**
 * The choices the dashboard card form offers.
 *
 * **A plain module, because neither end can hold it.** A `"use server"` file may
 * only export async functions — Next refuses the whole module at build time if
 * it exports a constant, and the error arrives as a failed action rather than as
 * a compile error — and a client component cannot be imported by one. So the
 * list of axes lives here, where the action that validates against it and the
 * form that renders it can both read the same one.
 *
 * A subset of what `layout` can hold, deliberately (D-104): the generality is in
 * the data, so a filter builder written later needs no migration.
 */

/**
 * What a chart may be grouped by.
 *
 * **Single-valued fields only.** Assignee is the one people ask for and it is
 * not here: a task with three assignees belongs to three groups, which a single
 * group key cannot say, so the compiler refuses it (D-104's note, and the bug
 * that found it). "Tasks per person" needs a renderer that can put one task in
 * several bars, which is a different card kind rather than a different axis.
 */
export const CHART_AXES = ["status", "statusGroup", "priority", "taskType", "list"] as const;

export type ChartAxis = (typeof CHART_AXES)[number];

export const STAT_METRICS = ["open", "done", "overdue", "points", "estimate"] as const;

export type StatMetric = (typeof STAT_METRICS)[number];

export const METRIC_LABELS: Record<StatMetric, string> = {
  open: "Open tasks",
  done: "Tasks done",
  overdue: "Overdue tasks",
  points: "Story points",
  estimate: "Estimated time",
};

export const AXIS_LABELS: Record<ChartAxis, string> = {
  status: "Status",
  statusGroup: "Stage",
  priority: "Priority",
  taskType: "Task type",
  list: "List",
};
