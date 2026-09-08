# History — what each phase cost, and what looking at the screen found

Split out of `docs/STATUS.md` so the file a new session reads is current state
rather than an accumulating record. Nothing here is needed to work on the
project; it is here because it is the part worth explaining out loud, and
because "we already learned this" is only useful if it is written down.

`DECISIONS.md` holds the choices. This holds what it was like to make them.

---

## Bugs that survived every automated check

Two were found and fixed during this pass, both by looking rather than by
reasoning.

**Writes were never authorized.** Reads have been permission-scoped since ADR 3
— every view query joins `access_index`, so a task in a list you cannot reach
never reaches a screen. Writes only ever established *who* was asking. Six
actions called `requireUser` and then wrote, and `undo` was the worst of them:
it takes an `Operation[]` straight from the client, so a hand-built batch could
name any task in the workspace. It survived five phases because it was
unreachable in practice — the only way to get a task id was to render a row, and
rendering was scoped. The detail page is what made it reachable, so it had to be
closed before the page landed (D-080).

**And closing it was not a fix until the sharing actions were closed too.**
`shareContainerAction` let any signed-in user grant themselves `manage` on any
container, so the task check was one extra request away from irrelevant: grant,
then edit legitimately. `check:actions` now performs exactly that sequence —
reverting the fix renames a task in a private list to "Renamed after granting
myself access" (D-081).

**A breadcrumb read "Founders › Founders › Hiring".** A list sitting directly
under a space matched that space as its folder as well, because the join had no
`kind` test. Invisible until a page existed for a task in a folderless list.

**The seed decided who the owner was by physical row order.** Re-seeding an
existing database returns nothing from `onConflictDoNothing`, so it fell back to
`select().from(users).limit(4)` — with no `ORDER BY` — and destructured the
result as `[avery, riley, sam, jordan]`. Postgres returns rows in whatever order
they physically sit in, which changes when they are updated, and `setPassword`
updates all four on every seed. So one day Sam was the owner and Avery a member,
and eleven permission checks failed describing symptoms that had nothing to do
with permissions. It had been latent since the first seed and only surfaced
after enough re-seeds moved a row. The fix is four lines: bind by email.

The lesson is not about seeds. **A check that fails because its fixture is wrong
is worse than a check that fails**, because it sends you into the code it was
testing. This one cost half an hour of reading a query that was correct.

**Two clocks.** The ambient checks fence on `activity.at`, which Postgres
stamps, and originally took the fence from `new Date()` in the test process.
Postgres is in a VM whose clock drifts tens of milliseconds either side of the
host's, so the *previous* section's writes fell inside the window at random and
the query looked like it was ignoring its own filter. The fence has to come from
the same clock as the data: `SELECT now()`.

---

---

## The renderer bet, and what browser verification kept finding

**The permission checks are the ones to read.** They assert the property
through a compiled view query — a task in a private list not coming back —
rather than by inspecting the access index, because the index being right is
not the thing that matters. The seed now computes the index with the real job
instead of writing "everyone can manage everything" by hand, which is what made
it possible to have a permission bug the demo could not show.

**The renderer bet, measured twice.** The board took no compiler change, no new
SQL, and one new server action (`moveTask`, because dragging is a mutation the
list never needed).

The table is the more interesting measurement, because it is the first renderer
that needed something the compiler did not have. It runs the list's query
unchanged — no new SQL shape, no new join, no second query for rows — but it
needed two things beside it: four more built-in columns in the SELECT list
(D-061), and a per-page lookup for custom field values, which are one row per
(task, field) in the EAV table and cannot be projected without a subquery each
(D-062). Both live in the compiler and the shared read path respectively;
neither is a query belonging to a renderer, which is the line that matters.

**The calendar settled it.** It is the first view whose shape is not a sequence
of rows, and it needed no compiler change and no new SQL — a month is the
list's query with one condition appended, using the `between` operator that was
already there (D-068). What it did need was `loadView` learning that a renderer
may *narrow* the query in a way the URL cannot widen back, and a page size
raised to the compiler's maximum, because a month is a bounded window rather
than a page someone scrolls.

Five renderers, one query — and the detail page is the first screen that does
*not* go through the compiler, which is the boundary rather than an exception.
A view compiles "which rows"; a task page already knows the row. What it could
not skip was the `access_index` join the compiler had been providing for free
on every other screen (D-082).

**Browser-verified 2026-09-05**, the first time in this project's history:
board drag lands where aimed, undo restores both the column and the place in
it, ⌘Z works from the keyboard, status cycling works, the status deletion
prompt reports how many tasks would move, and a duplicate status name is
refused with the input snapping back.

It found three bugs that every automated check had passed — a toast that
counted operations and called them tasks, a drop handler that read the dragged
id from React state instead of `dataTransfer`, and refused edits that left the
rejected value in the input (D-052, D-053). None of them were reachable from
the server side, which is the whole argument for looking at the screen.

**The table was verified the same way**, and it earned its keep again: a
malformed `?s=` link reported "Could not reach the database" and told you to
start Docker; sortable headers were only clickable on the words themselves,
leaving most of each header cell dead; and putting the column chooser beside
the filter bar collapsed the bar to content width, stranding its "Show closed"
toggle mid-row. All three passed every automated check.

**The calendar found two more**, one of them older than it: every date-only due
date displayed a day early (D-067), which was invisible until a task had to sit
in a square; and the sidebar's task count was whatever the renderer had drawn,
so an empty month reported the list as empty (D-069).

**The detail page found one older than the whole feature**, and it is the same
shape: a list sitting directly under a space matched that space as its folder
as well, because the join had no `kind` test. It had been in `loadView` since
the beginning and could not be seen, because the only list the app rendered had
a real folder. A page for a task in a folderless list is what made "Founders ›
Founders › Hiring" appear on screen.

Two things worth noting about verifying this pass in a browser. **A synthetic
drag does not trigger HTML5 drag-and-drop**: the calendar and board drags both
fail under `left_click_drag`, which is the tool and not the app — the calendar
drop was confirmed by dispatching real `DragEvent`s and checking Postgres.
And **the first click after a navigation is still swallowed** while the page
hydrates, which cost twenty minutes here on a checkbox that looked broken and
was not.

---
