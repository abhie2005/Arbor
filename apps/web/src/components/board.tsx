"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { moveTask } from "@/server/actions";

import { useUndo } from "./undo";

/**
 * Drag and drop, with no drag-and-drop library.
 *
 * Native HTML5 drag events do everything a board column needs, and a
 * dependency here would have to be re-tokenized against the design system and
 * carried forever for one interaction (D-030 is about not letting imported
 * components set the visual language; the same argument applies to behaviour).
 *
 * Two decisions make this correct rather than merely working:
 *
 * 1. **The drop names its neighbours, not an index.** An index describes a list
 *    the client rendered a moment ago. The neighbours are rows, and the server
 *    turns them into a fractional key that lands between them whatever else
 *    moved meanwhile (D-012). One row is written; the column is not renumbered.
 * 2. **The move is optimistic through `useOptimistic`.** The card arrives in
 *    its new column on drop, not a round trip later, and React reconciles
 *    against the server's answer when it lands — so a rejected move snaps back
 *    without this component keeping a shadow copy of the board.
 * 3. **What is being dragged is read from `dataTransfer`, not from state.**
 *    React state is set during `dragstart` and read during `drop`, and those
 *    are separate commits — a drop that arrives before the state lands would
 *    read `null` and silently do nothing. `dataTransfer` is the payload channel
 *    the drag API provides for exactly this, and it is available on the drop
 *    event no matter what React has committed. State is kept only for the
 *    things that are genuinely visual: dimming the card and placing the
 *    insertion line.
 */

export interface BoardCard {
  id: string;
  key: string | null;
  name: string;
  priority: number | null;
  dueAt: string | null;
  statusGroup: string | null;
  assignees: string[];
  subtaskCount: number;
}

export interface BoardColumn {
  statusId: string;
  name: string;
  group: string;
  color: string;
  count: number;
  cards: BoardCard[];
}

interface Move {
  taskId: string;
  toStatusId: string;
  toIndex: number;
}

/** Where the card would land if dropped right now. */
interface DropTarget {
  statusId: string;
  index: number;
}

function applyMove(columns: BoardColumn[], move: Move): BoardColumn[] {
  const card = columns.flatMap((column) => column.cards).find((c) => c.id === move.taskId);
  if (!card) return columns;

  return columns.map((column) => {
    const without = column.cards.filter((c) => c.id !== move.taskId);
    if (column.statusId !== move.toStatusId) return { ...column, cards: without };

    const next = [...without];
    next.splice(Math.min(move.toIndex, next.length), 0, { ...card, statusGroup: column.group });
    return { ...column, cards: next };
  });
}

export function Board({ columns }: { columns: BoardColumn[] }) {
  const router = useRouter();
  const { record } = useUndo();
  const [pending, startTransition] = useTransition();
  const [optimistic, applyOptimistic] = useOptimistic(columns, applyMove);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  function drop(statusId: string, index: number, taskId: string | null) {
    setDragging(null);
    setTarget(null);
    if (!taskId) return;

    // Neighbours are read from the column as it will be *after* the card
    // leaves it — dropping a card one slot down inside its own column would
    // otherwise be measured against a list that still contains it.
    const column = optimistic.find((c) => c.statusId === statusId);
    if (!column) return;

    const without = column.cards.filter((card) => card.id !== taskId);
    const at = Math.min(index, without.length);
    const before = without[at - 1]?.id ?? null;
    const after = without[at]?.id ?? null;

    if (before === null && after === null && column.cards.length === 1 && column.cards[0]?.id === taskId) {
      return; // Only card in the column, dropped back into it.
    }

    setFailure(null);
    startTransition(async () => {
      applyOptimistic({ taskId, toStatusId: statusId, toIndex: at });
      try {
        const inverse = await moveTask(taskId, statusId, before, after);
        // One drag is one undo entry, even though it changed two fields.
        if (inverse.length > 0) record(inverse);
        router.refresh();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : "That move did not save");
      }
    });
  }

  return (
    <>
      <div className="board" data-pending={pending || undefined}>
        {optimistic.map((column) => (
          <Column
            key={column.statusId}
            column={column}
            dragging={dragging}
            target={target?.statusId === column.statusId ? target.index : null}
            onDragStart={setDragging}
            onDragEnd={() => {
              setDragging(null);
              setTarget(null);
            }}
            onHover={(index) => setTarget({ statusId: column.statusId, index })}
            onDrop={(index, taskId) => drop(column.statusId, index, taskId)}
          />
        ))}
      </div>

      {failure ? (
        <p className="board-error" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}

function Column({
  column,
  dragging,
  target,
  onDragStart,
  onDragEnd,
  onHover,
  onDrop,
}: {
  column: BoardColumn;
  dragging: string | null;
  target: number | null;
  onDragStart: (taskId: string) => void;
  onDragEnd: () => void;
  onHover: (index: number) => void;
  onDrop: (index: number, taskId: string | null) => void;
}) {
  const token = column.group.replace("_", "-");

  return (
    <section
      className="board-column"
      onDragOver={(event) => {
        // Without preventDefault the browser refuses the drop entirely.
        event.preventDefault();
        if (event.currentTarget === event.target) onHover(column.cards.length);
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(target ?? column.cards.length, draggedId(event));
      }}
    >
      <header className="board-head">
        <span className="board-name" style={{ color: `var(--status-${token})` }}>
          {column.name}
        </span>
        <span className="board-count">{column.count}</span>
      </header>

      <div className="board-cards">
        {column.cards.map((card, index) => (
          <div key={card.id}>
            {target === index ? <div className="board-slot" /> : null}
            <Card
              card={card}
              dragging={dragging === card.id}
              onDragStart={() => onDragStart(card.id)}
              onDragEnd={onDragEnd}
              onHover={(half) => onHover(half === "top" ? index : index + 1)}
              onDrop={(half, taskId) => onDrop(half === "top" ? index : index + 1, taskId)}
            />
          </div>
        ))}

        {target === column.cards.length ? <div className="board-slot" /> : null}

        {column.cards.length === 0 ? <p className="board-empty">Nothing here</p> : null}
      </div>
    </section>
  );
}

function Card({
  card,
  dragging,
  onDragStart,
  onDragEnd,
  onHover,
  onDrop,
}: {
  card: BoardCard;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onHover: (half: "top" | "bottom") => void;
  onDrop: (half: "top" | "bottom", taskId: string | null) => void;
}) {
  /** Above the midpoint inserts before this card, below inserts after it. */
  function half(event: React.DragEvent<HTMLElement>): "top" | "bottom" {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientY < box.top + box.height / 2 ? "top" : "bottom";
  }

  const due = formatDue(card.dueAt);

  return (
    <article
      className="card"
      draggable
      data-dragging={dragging || undefined}
      onDragStart={(event) => {
        // Firefox will not start a drag without data on the transfer object.
        event.dataTransfer.setData("text/plain", card.id);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onHover(half(event));
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDrop(half(event), draggedId(event));
      }}
    >
      <div className="card-top">
        <span className="key">{card.key ?? "—"}</span>
        {card.priority ? (
          <span className="flag" data-priority={card.priority} title={`Priority ${card.priority}`}>
            ▲
          </span>
        ) : null}
      </div>

      <p className="card-name">{card.name}</p>

      <div className="card-foot">
        <span className="date" data-overdue={due.overdue} data-empty={due.empty}>
          {due.label}
        </span>
        {card.subtaskCount > 0 ? (
          <span className="card-subs">{card.subtaskCount} subtasks</span>
        ) : null}
        <span className="avatars">
          {card.assignees.map((person) => (
            <span
              key={person}
              className="avatar"
              style={{ background: avatarColor(person) }}
              title={person}
            >
              {initials(person)}
            </span>
          ))}
        </span>
      </div>
    </article>
  );
}

/** The task id the drag is carrying. Set on dragstart, read on drop. */
function draggedId(event: React.DragEvent<HTMLElement>): string | null {
  return event.dataTransfer.getData("text/plain") || null;
}

function formatDue(value: string | null) {
  if (!value) return { label: "—", overdue: false, empty: true };
  const date = new Date(value);
  return {
    label: date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric" }),
    overdue: date.getTime() < Date.now(),
    empty: false,
  };
}

function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function avatarColor(name: string) {
  const hues = [
    "var(--avatar-1)",
    "var(--avatar-2)",
    "var(--avatar-3)",
    "var(--avatar-4)",
    "var(--avatar-5)",
  ];
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hues[hash % hues.length];
}
