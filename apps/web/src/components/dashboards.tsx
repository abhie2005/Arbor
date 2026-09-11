"use client";

import { formatDuration } from "@arbor/core";
import type { CardSlice, ResolvedCard } from "@arbor/db";
import { useEffect, useState, useTransition } from "react";

import {
  addDashboardCard,
  createWorkspaceDashboard,
  removeDashboardCard,
  removeWorkspaceDashboard,
  renameWorkspaceDashboard,
} from "@/server/dashboard-actions";
import type { DashboardScope, DashboardView } from "@/server/dashboards";

import {
  AXIS_LABELS,
  CHART_AXES,
  METRIC_LABELS,
  STAT_METRICS,
  type ChartAxis,
  type StatMetric,
} from "./card-options";

import { useServerValue } from "./use-server-value";

/**
 * Dashboards.
 *
 * **Every number here is the reader's own** (D-105), which is the opposite of a
 * goal's rollup and worth saying on screen rather than leaving to be
 * discovered: two people looking at one dashboard can legitimately see
 * different totals, and without a sentence somewhere that reads as a bug.
 *
 * A card that could not be drawn says why in its own tile. A dashboard is
 * independent pieces, and one broken filter should cost one tile (D-104).
 */

function useDashboardAction() {
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

export function Dashboards({
  dashboards,
  scopes,
  canCreate,
}: {
  dashboards: DashboardView[];
  scopes: DashboardScope[];
  canCreate: boolean;
}) {
  const { run, pending, failure } = useDashboardAction();

  return (
    <div className="dashboards" data-pending={pending || undefined}>
      {failure ? (
        <p className="detail-error" role="alert">
          {failure}
        </p>
      ) : null}

      {canCreate ? <NewDashboard scopes={scopes} run={run} /> : null}

      {dashboards.length === 0 ? (
        <p className="dash-empty">
          No dashboards yet. A dashboard is a grid of cards; each card is a filter and a way of
          drawing it.
        </p>
      ) : null}

      {dashboards.map((dashboard) => (
        <Dashboard key={dashboard.id} dashboard={dashboard} scopes={scopes} run={run} />
      ))}
    </div>
  );
}

function NewDashboard({
  scopes,
  run,
}: {
  scopes: DashboardScope[];
  run: (action: () => Promise<unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");
  const [personal, setPersonal] = useState(false);

  const submit = () => {
    if (!name.trim()) return;
    run(() => createWorkspaceDashboard(name, scopeId || null, personal));
    setName("");
    setPersonal(false);
  };

  return (
    <div className="dash-new">
      <input
        type="text"
        placeholder="What is this dashboard about?"
        aria-label="Dashboard name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
      />

      <select
        aria-label="Where this dashboard lives"
        value={scopeId}
        onChange={(event) => setScopeId(event.target.value)}
      >
        {scopes.map((scope) => (
          <option key={scope.id} value={scope.id}>
            {scope.name}
          </option>
        ))}
      </select>

      {/* The saved view rule, verbatim (D-057): owned means invisible to
          everybody else. */}
      <label className="dash-personal">
        <input
          type="checkbox"
          checked={personal}
          onChange={(event) => setPersonal(event.target.checked)}
        />
        Only mine
      </label>

      <button type="button" onClick={submit} disabled={!name.trim()}>
        Add dashboard
      </button>
    </div>
  );
}

function Dashboard({
  dashboard,
  scopes,
  run,
}: {
  dashboard: DashboardView;
  scopes: DashboardScope[];
  run: (action: () => Promise<unknown>) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [focused, setFocused] = useState(false);
  const [name, setName] = useServerValue(dashboard.name, focused);

  return (
    <section className="dash">
      <div className="dash-head">
        <input
          className="dash-title"
          value={name}
          aria-label="Dashboard name"
          onChange={(event) => setName(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            if (name.trim() && name !== dashboard.name) {
              run(() => renameWorkspaceDashboard(dashboard.id, name));
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              setName(dashboard.name);
              event.currentTarget.blur();
            }
          }}
        />

        <span className="dash-where">
          {dashboard.containerName ?? "Workspace"}
          {dashboard.ownerId ? " · only mine" : null}
        </span>

        <button
          type="button"
          className="dash-delete"
          aria-label={`Delete ${dashboard.name}`}
          onClick={() => run(() => removeWorkspaceDashboard(dashboard.id))}
        >
          ×
        </button>
      </div>

      {/* Said rather than silently hidden: eleven of twelve cards is a state
          somebody has to be told about to fix. */}
      {dashboard.dropped > 0 ? (
        <p className="dash-dropped">
          {dashboard.dropped} card{dashboard.dropped === 1 ? "" : "s"} could not be read and{" "}
          {dashboard.dropped === 1 ? "was" : "were"} left out.
        </p>
      ) : null}

      {dashboard.resolved.length === 0 ? (
        <p className="dash-empty">No cards yet.</p>
      ) : (
        <div className="dash-grid">
          {dashboard.resolved.map((card) => (
            <Card key={card.id} card={card} onRemove={() => run(() => removeDashboardCard(dashboard.id, card.id))} />
          ))}
        </div>
      )}

      {adding ? (
        <NewCard
          dashboardId={dashboard.id}
          scopes={scopes}
          run={run}
          done={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="dash-add" onClick={() => setAdding(true)}>
          Add card
        </button>
      )}
    </section>
  );
}

function Card({ card, onRemove }: { card: ResolvedCard; onRemove: () => void }) {
  return (
    <article className="card" data-kind={card.kind} data-failed={card.failed ? "true" : undefined}>
      <div className="card-head">
        <h3 className="card-title">{card.title}</h3>
        <button type="button" className="card-delete" aria-label={`Remove ${card.title}`} onClick={onRemove}>
          ×
        </button>
      </div>

      {card.failed ? (
        <p className="card-failed">{card.failed}</p>
      ) : card.kind === "stat" ? (
        <p className="card-stat">
          <span className="card-number">{formatStat(card.value, card.unit)}</span>
          {card.unit ? <span className="card-unit">{card.unit}</span> : null}
        </p>
      ) : (
        <Bars slices={card.slices} />
      )}
    </article>
  );
}

/**
 * A stat's number.
 *
 * Milliseconds are the one unit that is not a count, and printing 32400000
 * where somebody expected "9h" is the kind of thing nobody notices until a
 * screenshot goes in a deck.
 */
function formatStat(value: number | null, unit: string | null): string {
  if (value === null) return "—";
  if (unit === "estimated") return formatDuration(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/**
 * A bar chart, in HTML.
 *
 * No charting library: this is a list of rows with a width, which is what a
 * horizontal bar chart is, and the dependency would be larger than the feature.
 * Bars are measured against the largest slice rather than the total — against
 * the total, four roughly equal groups are four stubs a quarter of the way
 * across, which is the comparison a bar chart exists to make easy.
 */
function Bars({ slices }: { slices: CardSlice[] }) {
  if (slices.length === 0) return <p className="card-empty">Nothing matches this filter.</p>;

  return (
    <ul className="card-bars">
      {slices.map((slice) => (
        <li key={slice.key ?? "none"} className="card-bar">
          <span className="card-bar-label" title={slice.label}>
            {slice.label}
          </span>
          <span className="card-bar-track">
            <span
              className="card-bar-fill"
              style={{
                width: `${Math.round(slice.fraction * 100)}%`,
                // A status brings its own colour; everything else takes the
                // accent, because inventing a palette per axis is how two
                // charts of the same data end up looking like different data.
                background: slice.color ?? undefined,
              }}
            />
          </span>
          <span className="card-bar-count">{slice.count}</span>
        </li>
      ))}
    </ul>
  );
}

function NewCard({
  dashboardId,
  scopes,
  run,
  done,
}: {
  dashboardId: string;
  scopes: DashboardScope[];
  run: (action: () => Promise<unknown>) => void;
  done: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"stat" | "chart">("stat");
  const [metric, setMetric] = useState<StatMetric>("open");
  const [axis, setAxis] = useState<ChartAxis>("status");
  const [scopeId, setScopeId] = useState(scopes[0]?.id ?? "");

  const submit = () => {
    if (!title.trim()) return;
    const scope = scopes.find((candidate) => candidate.id === scopeId);

    run(() =>
      addDashboardCard(dashboardId, {
        title,
        kind,
        scopeId: scope?.id,
        scopeKind: scope?.kind,
        metric,
        axis,
      }),
    );
    done();
  };

  return (
    <div className="dash-new-card">
      <input
        type="text"
        placeholder="What does this card say?"
        aria-label="Card title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <select
        aria-label="What kind of card"
        value={kind}
        onChange={(event) => setKind(event.target.value as "stat" | "chart")}
      >
        <option value="stat">One number</option>
        <option value="chart">A bar chart</option>
      </select>

      {kind === "stat" ? (
        <select
          aria-label="What to count"
          value={metric}
          onChange={(event) => setMetric(event.target.value as StatMetric)}
        >
          {STAT_METRICS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {METRIC_LABELS[candidate]}
            </option>
          ))}
        </select>
      ) : (
        <select
          aria-label="What to group by"
          value={axis}
          onChange={(event) => setAxis(event.target.value as ChartAxis)}
        >
          {CHART_AXES.map((candidate) => (
            <option key={candidate} value={candidate}>
              {AXIS_LABELS[candidate]}
            </option>
          ))}
        </select>
      )}

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

      <button type="button" onClick={submit} disabled={!title.trim()}>
        Add
      </button>
      <button type="button" onClick={done}>
        Cancel
      </button>
    </div>
  );
}
