"use client";

import type { Operation, RichDoc } from "@arbor/core";
import type { CommentRecord } from "@arbor/db";
import { useRef, useState } from "react";

import { type CommentResult, deleteComment, editComment, postComment } from "@/server/comment-actions";

import { useTaskAction } from "./use-task-action";

/**
 * The conversation on a task.
 *
 * **A textarea, and a document underneath.** Nothing here is contenteditable
 * and there is no editor dependency: what is typed is plain text, and
 * `parseRichText` on the server turns it into the stored block document,
 * resolving `@Name` against the people who could be meant (D-083). The format
 * is what is stored, not what is typed, which is the whole reason it could be
 * chosen properly before anything needed to render it.
 *
 * Posting goes through `useTaskAction` like every other write, so ⌘Z removes a
 * comment you just posted. That surprises people once, and it is true: it was
 * the last thing you did.
 */

export interface CommentsProps {
  taskId: string;
  comments: CommentRecord[];
  people: { id: string; name: string }[];
  canComment: boolean;
  viewerId: string;
}

export function Comments({ taskId, comments, people, canComment, viewerId }: CommentsProps) {
  const total = countComments(comments);

  return (
    <section className="detail-section comments">
      <h2>
        Comments{total > 0 ? <span className="comment-count">{total}</span> : null}
      </h2>

      {comments.length === 0 ? (
        <p className="comments-empty">Nothing here yet.</p>
      ) : (
        <ul className="comment-list">
          {comments.map((comment) => (
            <li key={comment.id}>
              <Comment
                comment={comment}
                taskId={taskId}
                people={people}
                canComment={canComment}
                viewerId={viewerId}
              />

              {comment.replies.length > 0 ? (
                <ul className="comment-replies">
                  {comment.replies.map((reply) => (
                    <li key={reply.id}>
                      <Comment
                        comment={reply}
                        taskId={taskId}
                        people={people}
                        canComment={canComment}
                        viewerId={viewerId}
                        isReply
                      />
                    </li>
                  ))}
                </ul>
              ) : null}

              {canComment && comment.deletedAt === null ? (
                <ReplyBox taskId={taskId} parentId={comment.id} people={people} />
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canComment ? <Composer taskId={taskId} parentId={null} people={people} /> : null}
    </section>
  );
}

function Comment({
  comment,
  taskId,
  people,
  canComment,
  viewerId,
  isReply = false,
}: {
  comment: CommentRecord;
  taskId: string;
  people: { id: string; name: string }[];
  canComment: boolean;
  viewerId: string;
  isReply?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const { run, pending, failure } = useTaskAction();

  // Only the author (D-083). Someone with `edit` on the list may change the
  // task in every other way and still not rewrite what another person said.
  const mine = canComment && comment.author.id === viewerId && comment.deletedAt === null;

  if (comment.deletedAt !== null) {
    return (
      <article className="comment comment-deleted" data-reply={isReply || undefined}>
        {/* The row stays so the replies under it keep their anchor. */}
        <span>This comment was deleted.</span>
      </article>
    );
  }

  return (
    <article className="comment" data-reply={isReply || undefined} data-pending={pending || undefined}>
      <header>
        <span className="comment-author">{comment.author.name}</span>
        <time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString("en-GB")}>
          {relative(comment.createdAt)}
        </time>
        {comment.edited ? <span className="comment-edited">edited</span> : null}

        {mine ? (
          <span className="comment-tools">
            <button type="button" onClick={() => setEditing((was) => !was)}>
              {editing ? "Cancel" : "Edit"}
            </button>
            <button type="button" onClick={() => run(() => deleteComment(comment.id))}>
              Delete
            </button>
          </span>
        ) : null}
      </header>

      {editing ? (
        <Composer
          taskId={taskId}
          parentId={null}
          people={people}
          initial={plain(comment.body)}
          submitLabel="Save"
          onDone={() => setEditing(false)}
          write={(text) => editComment(comment.id, text)}
        />
      ) : (
        <Body body={comment.body} />
      )}

      {failure ? <p className="detail-error" role="alert">{failure}</p> : null}
    </article>
  );
}

/**
 * A stored document, rendered.
 *
 * A mention draws as a chip rather than as "@Riley Kaur" in prose, because the
 * point of storing a node was that it is a reference and not a string. A body
 * that will not parse says so instead of rendering nothing — a comment that
 * silently disappears is worse than one that admits it is unreadable.
 */
function Body({ body }: { body: RichDoc | null }) {
  if (!body) {
    return <p className="comment-body comment-unreadable">This comment could not be displayed.</p>;
  }

  return (
    <div className="comment-body">
      {body.content.map((paragraph, index) => (
        // eslint-disable-next-line react/no-array-index-key -- paragraphs have no id
        <p key={index}>
          {paragraph.content.map((node, position) =>
            node.type === "mention" ? (
              // eslint-disable-next-line react/no-array-index-key
              <span className="mention" key={position}>
                @{node.label}
              </span>
            ) : (
              // eslint-disable-next-line react/no-array-index-key
              <span key={position}>{node.text}</span>
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function ReplyBox({
  taskId,
  parentId,
  people,
}: {
  taskId: string;
  parentId: string;
  people: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="comment-reply-open" onClick={() => setOpen(true)}>
        Reply
      </button>
    );
  }

  return (
    <div className="comment-reply-box">
      <Composer
        taskId={taskId}
        parentId={parentId}
        people={people}
        submitLabel="Reply"
        onDone={() => setOpen(false)}
      />
    </div>
  );
}

/**
 * The box.
 *
 * It carries the mention-consent flow (D-084): a post naming someone who cannot
 * see the task comes back refused, with the names, and the same text is sent
 * again only if the author says to. The pending text is held here so nothing is
 * lost while that question is on screen — being asked a question is not a
 * reason to retype a paragraph.
 */
function Composer({
  taskId,
  parentId,
  people,
  initial = "",
  submitLabel = "Comment",
  onDone,
  write,
}: {
  taskId: string;
  parentId: string | null;
  people: { id: string; name: string }[];
  initial?: string;
  submitLabel?: string;
  onDone?: () => void;
  write?: (text: string) => Promise<Operation[]>;
}) {
  const [text, setText] = useState(initial);
  const [blocked, setBlocked] = useState<Extract<CommentResult, { ok: false }> | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlighted, setHighlighted] = useState(0);
  const box = useRef<HTMLTextAreaElement>(null);
  const { run, pending, failure } = useTaskAction();

  // What the caret is currently inside, if it is inside a mention being typed.
  const partial = mentionUnderCaret(text, caret);
  const suggestions =
    partial === null
      ? []
      : people
          .filter((person) => person.name.toLowerCase().startsWith(partial.query.toLowerCase()))
          .slice(0, 6);
  const picking = suggestions.length > 0;

  function accept(person: { id: string; name: string }) {
    if (partial === null) return;
    // The full name goes in, because that is what the server parses against —
    // the picker inserts what `parseRichText` will recognise, rather than a
    // token only this component understands (D-083).
    const next = `${text.slice(0, partial.start)}@${person.name}${text.slice(caret)}`;
    const position = partial.start + person.name.length + 1;

    setText(next);
    setHighlighted(0);
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

  function submit(share: boolean) {
    const value = text.trim();
    if (!value) return;

    if (write) {
      run(() => write(value));
      setText(initial);
      onDone?.();
      return;
    }

    run(async () => {
      const result = await postComment(taskId, value, parentId, share);
      if (!result.ok) {
        setBlocked(result);
        // Nothing was written, so there is nothing to put on the undo stack.
        return [];
      }
      setBlocked(null);
      setText("");
      onDone?.();
      return result.operations;
    });
  }

  return (
    <div className="composer">
      {/* The picker anchors to the box, not to the whole composer — otherwise
          it opens below the buttons, which is nowhere near what is being
          typed. */}
      <div className="composer-input">
        <textarea
        ref={box}
        rows={3}
        value={text}
        placeholder="Write a comment. Type @ to mention someone."
        onChange={(event) => {
          setText(event.target.value);
          setCaret(event.target.selectionStart);
          setHighlighted(0);
          if (blocked) setBlocked(null);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onBlur={() => setCaret(-1)}
        onKeyDown={(event) => {
          if (picking) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlighted((index) => (index + 1) % suggestions.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              accept(suggestions[highlighted] ?? suggestions[0]!);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setCaret(-1);
              return;
            }
          }

          // ⌘/Ctrl+Enter posts. Plain Enter is a newline, because a comment is
          // prose and a paragraph break is more common than a send.
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit(false);
          }
        }}
      />

        {picking ? (
          <ul className="mention-picker" role="listbox">
            {suggestions.map((person, index) => (
              <li key={person.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlighted}
                  data-highlighted={index === highlighted || undefined}
                  // Mousedown, not click: click fires after blur, and blur has
                  // already closed the picker by then.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    accept(person);
                  }}
                >
                  {person.name}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {blocked ? (
        <div className="composer-consent" role="alert">
          <p>
            {names(blocked.unreachable.map((person) => person.name))}{" "}
            {blocked.unreachable.length === 1 ? "cannot" : "cannot"} see this task.
          </p>
          {blocked.canShare ? (
            <p>
              Posting will give {blocked.unreachable.length === 1 ? "them" : "them"} view access to{" "}
              <strong>{blocked.listName}</strong> — and to everything else in it.
            </p>
          ) : (
            <p>
              You cannot share <strong>{blocked.listName}</strong>, so an admin has to. Remove the
              mention to post without it.
            </p>
          )}

          <div className="composer-actions">
            {blocked.canShare ? (
              <button type="button" disabled={pending} onClick={() => submit(true)}>
                Post and give access
              </button>
            ) : null}
            <button type="button" onClick={() => setBlocked(null)}>
              Keep editing
            </button>
          </div>
        </div>
      ) : (
        <div className="composer-actions">
          <button type="button" disabled={pending || text.trim() === ""} onClick={() => submit(false)}>
            {submitLabel}
          </button>
          {onDone ? (
            <button type="button" onClick={onDone}>
              Cancel
            </button>
          ) : null}
        </div>
      )}

      {failure ? <p className="detail-error" role="alert">{failure}</p> : null}
    </div>
  );
}

/**
 * The mention the caret is inside, if it is inside one.
 *
 * Looks back from the caret for an "@" that is not preceded by a word
 * character — so an email address does not open the picker — and stops at
 * whitespace only when what follows could no longer be a name. Names contain
 * spaces, so one space is allowed inside the query and a second ends it;
 * otherwise "@Riley " would close the picker exactly when the surname is about
 * to be typed.
 */
function mentionUnderCaret(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 1) return null;

  for (let index = caret - 1; index >= 0 && caret - index <= 40; index -= 1) {
    const char = text[index]!;
    if (char === "\n") return null;

    if (char === "@") {
      const before = index === 0 ? "" : text[index - 1]!;
      if (before !== "" && /[\w@]/.test(before)) return null;

      const query = text.slice(index + 1, caret);
      // At most one space, so a mention can be "Riley Kaur" but a sentence
      // after an unmatched "@" does not keep the picker open.
      if ((query.match(/ /g) ?? []).length > 1) return null;
      return { start: index, query };
    }
  }

  return null;
}

function countComments(comments: CommentRecord[]): number {
  return comments.reduce(
    (total, comment) => total + (comment.deletedAt === null ? 1 : 0) + comment.replies.filter((r) => r.deletedAt === null).length,
    0,
  );
}

function plain(body: RichDoc | null): string {
  if (!body) return "";
  return body.content
    .map((paragraph) =>
      paragraph.content
        .map((node) => (node.type === "mention" ? `@${node.label}` : node.text))
        .join(""),
    )
    .join("\n\n");
}

function names(list: string[]): string {
  if (list.length === 1) return list[0]!;
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

/** Coarse on purpose: a comment thread does not need seconds. */
function relative(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
