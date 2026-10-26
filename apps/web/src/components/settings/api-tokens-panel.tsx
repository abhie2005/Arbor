"use client";

import { useState } from "react";

import { createApiTokenAction, revokeApiTokenAction } from "@/server/api-token-actions";

import { Timestamp } from "../timestamp";

export interface TokenContainer {
  id: string;
  name: string;
  kind: string;
  depth: number;
}

export interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  containerId: string;
  containerName: string;
  /** ISO strings: an instant crosses to the client as one (D-097). */
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

const PERMISSIONS = ["view", "comment", "edit", "manage"] as const;

/**
 * The tokens screen (D-135).
 *
 * **It lists what the viewer may manage, not what the workspace has** — the
 * shape D-123 arrived at the hard way, and the same one the automations screen
 * was built with from the start. A token names a container; a viewer who cannot
 * manage that container has no business knowing the token exists, and could not
 * revoke it anyway.
 *
 * **The token is shown once, here, and never again.** It is stored as a hash
 * (D-133), so this is not a design choice about secrecy so much as a statement
 * of fact: nothing can print it later because nothing has it. The panel keeps
 * it in state until the next mint or a dismissal, and says plainly that it is
 * the only time.
 */
export function ApiTokensPanel({
  containers,
  tokens,
}: {
  containers: TokenContainer[];
  tokens: TokenRow[];
}) {
  const [name, setName] = useState("");
  const [containerId, setContainerId] = useState(containers[0]?.id ?? "");
  const [permission, setPermission] = useState<(typeof PERMISSIONS)[number]>("edit");
  const [expiry, setExpiry] = useState("");
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  if (containers.length === 0) {
    return (
      <p className="settings-note">
        A token is minted against a container you manage, and you manage none in this workspace.
        Ask for <code>manage</code> on a space or a list, or an owner can mint one for you.
      </p>
    );
  }

  const mint = async () => {
    setBusy(true);
    setError(null);
    const days = expiry.trim() === "" ? undefined : Number(expiry);
    const result = await createApiTokenAction({
      containerId,
      name: name.trim(),
      permission,
      expiresInDays: Number.isFinite(days) && days !== undefined ? days : undefined,
    });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }
    if ("token" in result) {
      setMinted({ token: result.token, name: result.name });
      setName("");
      setExpiry("");
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    const result = await revokeApiTokenAction(id);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) setError(result.error);
  };

  return (
    <>
      {minted ? (
        <div className="settings-section" data-testid="minted-token">
          <h2 className="settings-heading">Copy it now</h2>
          <p className="settings-note">
            This is the only time <strong>{minted.name}</strong> can be read. It is stored as a
            hash, so nothing — this screen included — can print it again. Revoke it and mint
            another if it is lost.
          </p>
          <pre className="settings-input" data-testid="token-value">
            {minted.token}
          </pre>
          <button type="button" className="settings-quiet" onClick={() => setMinted(null)}>
            Done
          </button>
        </div>
      ) : null}

      <div className="settings-section">
        <h2 className="settings-heading">Mint a token</h2>
        <p className="settings-note">
          A token acts as a service account of its own, scoped to the container you choose and
          nothing else. Its writes appear in history under the name you give it, so name it after
          the integration rather than after yourself.
        </p>

        <div className="settings-form">
          <input
            className="settings-input"
            placeholder="What is it for — the nightly importer"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-label="Token name"
          />
          <select
            className="settings-select"
            value={containerId}
            onChange={(event) => setContainerId(event.target.value)}
            aria-label="Container"
          >
            {containers.map((container) => (
              <option key={container.id} value={container.id}>
                {" ".repeat(container.depth * 2)}
                {container.name}
              </option>
            ))}
          </select>
          <select
            className="settings-select"
            value={permission}
            onChange={(event) =>
              setPermission(event.target.value as (typeof PERMISSIONS)[number])
            }
            aria-label="Permission"
          >
            {PERMISSIONS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
          <input
            className="settings-input"
            placeholder="Expires in days (optional)"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
            aria-label="Expires in days"
            inputMode="numeric"
          />
          <button
            type="button"
            className="settings-primary"
            disabled={busy || name.trim() === ""}
            onClick={mint}
          >
            Mint
          </button>
        </div>

        {error ? <p className="settings-error">{error}</p> : null}
      </div>

      <div className="settings-section">
        <h2 className="settings-heading">Tokens</h2>
        {tokens.length === 0 ? (
          <p className="settings-note">None yet.</p>
        ) : (
          <div className="sharing-tree">
            {tokens.map((token) => (
              <div className="sharing-node" key={token.id} data-revoked={!!token.revokedAt}>
                <div>
                  <strong>{token.name}</strong>
                  <span className="sharing-kind">{token.containerName}</span>
                  <code className="settings-badge quiet">{token.prefix}…</code>
                </div>

                <div className="sharing-detail">
                  {token.revokedAt ? (
                    <span className="settings-badge quiet">
                      revoked <Timestamp at={token.revokedAt} />
                    </span>
                  ) : (
                    <>
                      <span className="settings-quiet">
                        {token.lastUsedAt ? (
                          <>
                            last used <Timestamp at={token.lastUsedAt} />
                          </>
                        ) : (
                          "never used"
                        )}
                      </span>
                      {token.expiresAt ? (
                        <span className="settings-badge quiet">
                          expires <Timestamp at={token.expiresAt} />
                        </span>
                      ) : null}
                      {confirming === token.id ? (
                        <span className="settings-confirm">
                          <button
                            type="button"
                            className="settings-danger"
                            disabled={busy}
                            onClick={() => revoke(token.id)}
                          >
                            Revoke it
                          </button>
                          <button
                            type="button"
                            className="settings-quiet"
                            onClick={() => setConfirming(null)}
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="settings-icon danger"
                          title={`Revoke ${token.name}`}
                          aria-label={`Revoke ${token.name}`}
                          onClick={() => setConfirming(token.id)}
                        >
                          ×
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
