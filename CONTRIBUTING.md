# Contributing

## Setup

```bash
cp .env.example .env
npm install
npm run docker:up
npm run db:migrate && npm run db:seed
npm test && npm run db:smoke
```

If `docker compose up` does not work on a clean machine, that is a P1 bug —
report it. The quickstart is the project's first impression.

## Ground rules

- **Sign off your commits** (`git commit -s`). We use the
  [DCO](https://developercertificate.org/); there is no CLA.
- **One component per PR** when importing from [21st.dev](https://21st.dev),
  with screenshots in both themes, and a row added to
  `packages/ui/ATTRIBUTIONS.md`.
- **Log the decision.** Add an entry to [`DECISIONS.md`](DECISIONS.md) in the
  same PR whenever you make a non-obvious call — a library choice, a rejected
  alternative, a trade-off you knowingly accepted. State what you *didn't* do
  and why; that's the part nobody can reconstruct later.
- **Write the ADR** if the change is structural enough that reversing it would
  be expensive. `docs/decisions/`, numbered, never deleted — superseded ADRs get
  a status line, not a rewrite.
- **`packages/core` stays framework-free.** No database handles, no request
  objects, no framework imports. It is the most testable part of the codebase
  and it should stay that way.

## Where to start

Good first issues are shaped like this — self-contained, visible, satisfying:

- A new **view renderer** (calendar, table, workload) over the existing compiler.
- A new **custom field type**: add to the enum, the type config schema, and the
  compiler's value-column mapping.
- A **keyboard shortcut** from the interface plan that isn't wired up yet.
- A **filter operator** the compiler doesn't support.

## Testing

Unit tests for `packages/core` run with no database:

```bash
npm test
```

The view compiler additionally has a live check against a real Postgres, which
is what catches SQL that typechecks but doesn't parse:

```bash
npm run db:seed && npm run db:smoke
```

Add a case to `packages/db/src/smoke.ts` whenever you change the compiler.

## Style

Match the surrounding code. Comments explain **why**, not what — the schema and
the compiler are heavily commented because the reasoning behind them is not
recoverable from the code, and that is the standard to hold.
