import { findMatches, highlight } from "@arbor/core";
import type { Match } from "@arbor/core";

import type { SearchResults } from "@/server/search";

import { relative } from "./relative-time";

/**
 * The results list.
 *
 * **A server component, deliberately.** Nothing here is interactive: the query
 * lives in the URL, the box that changes it is in the shell, and a result is a
 * link. Making this a client component would ship the highlighter to the
 * browser to re-derive marks the server already knows.
 *
 * **Tasks and documents stay in separate sections** (D-113). Interleaving them
 * would need a relevance score comparing a task's name against a page's prose,
 * and `ILIKE` does not produce one — an invented score is worse than an honest
 * grouping, because it looks like ranking.
 */

export function SearchResultsList({ results }: { results: SearchResults }) {
  const { tasks, docs, term } = results;
  const statusOf = new Map(results.statuses.map((status) => [status.id, status]));
  const nothing = tasks.length === 0 && docs.length === 0;

  if (nothing) {
    return (
      <div className="search-empty">
        <p>
          Nothing matches <strong>{term}</strong>.
        </p>
        <p className="search-empty-hint">
          Search looks at task names, page titles and page text — in everything you can reach.
        </p>
      </div>
    );
  }

  return (
    <div className="search-results">
      {tasks.length > 0 ? (
        <section className="search-section">
          <h2 className="search-heading">
            Tasks<span className="search-count">{tasks.length}</span>
            {results.taskLimitHit ? <span className="search-more">first {tasks.length}</span> : null}
          </h2>

          <ul className="search-list">
            {tasks.map((task) => {
              const status = task.statusId ? statusOf.get(task.statusId) : undefined;
              return (
                <li key={task.id} className="search-hit">
                  <a className="search-hit-link" href={task.key ? `/t/${task.key}` : "#"}>
                    <span className="search-hit-title" data-closed={task.statusGroup === "closed" ? "" : undefined}>
                      <Marked text={task.name} term={term} />
                    </span>
                    <span className="search-hit-meta">
                      {status ? (
                        <span className="search-status" style={{ background: status.color }}>
                          {status.name}
                        </span>
                      ) : null}
                      {task.key ? <code className="search-key">{task.key}</code> : null}
                      {task.path ? <span className="search-path">{task.path}</span> : null}
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {docs.length > 0 ? (
        <section className="search-section">
          <h2 className="search-heading">
            Pages<span className="search-count">{docs.length}</span>
            {results.docLimitHit ? <span className="search-more">first {docs.length}</span> : null}
          </h2>

          <ul className="search-list">
            {docs.map((doc) => (
              <li key={doc.id} className="search-hit">
                <a className="search-hit-link" href={`/docs?doc=${doc.id}`}>
                  <span className="search-hit-title">
                    <Marked text={doc.title} term={term} />
                  </span>

                  {/* The snippet is why this row is a result when the title did
                      not match. Absent for a page created and never written in. */}
                  {doc.snippet && doc.snippet.text ? (
                    <span className="search-snippet">
                      {doc.snippet.truncatedStart ? "… " : null}
                      <Runs text={doc.snippet.text} matches={doc.snippet.matches} />
                      {doc.snippet.truncatedEnd ? " …" : null}
                    </span>
                  ) : null}

                  <span className="search-hit-meta">
                    <span className="search-path">{doc.containerName ?? "Workspace"}</span>
                    <span className="search-when">{relative(doc.updatedAt.toISOString())}</span>
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * `text` with the term marked.
 *
 * Runs, not a string of `<mark>` tags: the text is a task's name or a
 * document's prose, and nothing in this app hands the browser markup it
 * assembled from user content. React escapes each run because each run is a
 * child, not HTML.
 */
function Marked({ text, term }: { text: string; term: string }) {
  return <Runs text={text} matches={undefined} term={term} />;
}

function Runs({
  text,
  matches,
  term,
}: {
  text: string;
  matches?: readonly Match[];
  term?: string;
}) {
  // Offsets computed by the loader for a snippet (they are offsets into the
  // window, not the document), or scanned here for a title, which is short.
  const ranges = matches ?? (term ? findMatches(text, term) : []);

  return (
    <>
      {highlight(text, ranges).map((run, index) =>
        run.hit ? (
          <mark key={index} className="search-mark">
            {run.text}
          </mark>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </>
  );
}
