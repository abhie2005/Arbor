/**
 * API tokens, and what a request that is not a session acts as.
 *
 * **A named service account per integration** (D-133). D-126 settled what an
 * automation authenticates as — a real `users` row with `kind = 'service'`, a
 * membership, and grants like anybody else — and left the API's half of the
 * question open. This is the same answer: a token names an account, the
 * account is the principal every read already joins `access_index` for, and no
 * permission code path is added anywhere.
 *
 * **A token is minted against one container, and the minter must hold `manage`
 * on it** — the rule D-129 set for writing an automation, for the same reason.
 * So a token is least-privilege by construction rather than by convention: a
 * brand-new service account reaches nothing, and the grant written at creation
 * is the whole of what the token can touch. Widening or narrowing it afterwards
 * is the sharing screen, which lists service accounts because an integration
 * needing access is exactly what a grant is for.
 *
 * **The order of writes is the failure mode.** The account, its membership and
 * the token row are one transaction; the grant is the ordinary `grantAccess`
 * afterwards, with its own activity row and its own index rebuild inside its
 * own transaction (D-071). If the grant fails, what is left is a token that
 * reaches nothing — which is what a revoked token is, and the safe direction to
 * fail in. The reverse order would leave a container reachable by a token
 * nobody was ever handed.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { grantAccess } from "./access";
import { pool } from "./client";
import { type ConfigContext, ConfigError, inTransaction, logConfigChange } from "./config";

type Connection = Pool | PoolClient;

/** 32 bytes, base64url. The prefix is cosmetic and is stored separately. */
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "arb_";
/** Enough of the token to recognise it in a list, not enough to use it. */
const SHOWN = TOKEN_PREFIX.length + 8;

export interface ApiTokenRecord {
  id: string;
  workspaceId: string;
  principalId: string;
  name: string;
  /** The container it was minted against, not the sum of its grants today. */
  containerId: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface TokenPrincipal {
  tokenId: string;
  workspaceId: string;
  /** The service account. This is the `viewerId` and the `actorId`. */
  principalId: string;
  name: string;
}

/** sha256, as `sessions` does it: the token is never stored, only its hash. */
function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createApiToken(
  input: {
    workspaceId: string;
    /** What the integration is, in a person's words. Becomes the account's name. */
    name: string;
    containerId: string;
    permission: "view" | "comment" | "edit" | "manage";
    expiresInDays?: number;
  },
  context: ConfigContext,
): Promise<{ token: string; record: ApiTokenRecord }> {
  const name = input.name.trim();
  if (!name) throw new ConfigError("A token needs a name, so its writes can be attributed");

  const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt =
    input.expiresInDays === undefined
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const record = await inTransaction(context, async (client) => {
    /**
     * The synthetic address is keyed by **its own** id rather than by the
     * workspace's.
     *
     * `users.email` is unique and not null, and a service account has no
     * mailbox — so the address is a placeholder either way. D-126 keyed the
     * automation account's on the workspace id, which made a re-seeded database
     * accumulate one per generation; keying it on a fresh uuid means there can
     * be as many named integrations per workspace as somebody mints, which is
     * the point of naming them.
     */
    const created = await client.query<{ id: string }>(
      `INSERT INTO users (email, name, kind) VALUES ($1, $2, 'service') RETURNING id`,
      [`svc+${randomUUID()}@service.arbor.local`, name],
    );
    const principalId = created.rows[0]!.id;

    /**
     * A **guest**, which is what makes "minted against one container" true.
     *
     * A principal with no membership at all is dropped by `resolveAccess` — a
     * grant to a non-member is inert by design (D-126) — so the account has to
     * be a member of something. As a `member` it would inherit
     * `ROLE_BASELINE.member`, which is `edit` on every container nobody marked
     * private: a token "scoped to one space" would quietly read the whole
     * workspace. `check:api` caught exactly that, with the private space as the
     * only thing it could not reach.
     *
     * `guest` has a baseline of `null` and the comment on it in
     * `packages/core/src/access.ts` already describes this case: somebody
     * invited to specific things, for whom "everything not marked private" is
     * precisely the wrong default. Grants still apply — they are what let a
     * guest into an open list — so the token reaches what it was granted and
     * nothing else.
     */
    await client.query(
      `INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'guest')
       ON CONFLICT DO NOTHING`,
      [input.workspaceId, principalId],
    );

    const row = await client.query<{
      id: string;
      created_at: Date;
    }>(
      `INSERT INTO api_tokens
         (workspace_id, principal_id, name, container_id, token_hash, prefix, created_by,
          expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, created_at`,
      [
        input.workspaceId,
        principalId,
        name,
        input.containerId,
        tokenHash(token),
        token.slice(0, SHOWN),
        context.actorId,
        expiresAt,
      ],
    );

    /**
     * Logged against the **container**, not the token.
     *
     * `object_kind` is an enum and there is no member for a token, but the fact
     * worth recording is not "a token exists" — it is that this container
     * became reachable by one. That is a sentence about the container, and it
     * lands in the same history the sharing screen writes to.
     */
    await logConfigChange(client, {
      workspaceId: input.workspaceId,
      actorId: context.actorId,
      objectKind: "container",
      objectId: input.containerId,
      verb: "api_token.created",
      newValue: { name, permission: input.permission, prefix: token.slice(0, SHOWN) },
    });

    return {
      id: row.rows[0]!.id,
      workspaceId: input.workspaceId,
      principalId,
      name,
      containerId: input.containerId,
      prefix: token.slice(0, SHOWN),
      createdAt: row.rows[0]!.created_at,
      lastUsedAt: null,
      expiresAt,
      revokedAt: null,
    } satisfies ApiTokenRecord;
  });

  await grantAccess(
    {
      containerId: input.containerId,
      principalKind: "user",
      principalId: record.principalId,
      permission: input.permission,
    },
    context,
  );

  // The only time the token itself exists outside the caller's hands.
  return { token, record };
}

/**
 * Who a bearer token speaks as, or null.
 *
 * **One statement authenticates and records the use**, so a token that has
 * never been called can be told from one that is working — which is the only
 * way to find a token nobody needs any more. It costs a write per request and
 * buys the answer to "can I revoke this?".
 *
 * Revoked and expired are checked here rather than by the caller, because a
 * caller that forgets is a caller that accepts a dead token.
 */
export async function principalForToken(
  token: string,
  connection: Connection = pool(),
): Promise<TokenPrincipal | null> {
  if (!token || !token.startsWith(TOKEN_PREFIX)) return null;

  const result = await connection.query<{
    id: string;
    workspace_id: string;
    principal_id: string;
    name: string;
  }>(
    `UPDATE api_tokens SET last_used_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, workspace_id, principal_id, name`,
    [tokenHash(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    tokenId: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    name: row.name,
  };
}

/** What a settings screen lists. Never the hash, which it could not use anyway. */
export async function listApiTokens(
  workspaceId: string,
  connection: Connection = pool(),
): Promise<ApiTokenRecord[]> {
  const result = await connection.query<{
    id: string;
    workspace_id: string;
    principal_id: string;
    name: string;
    container_id: string;
    prefix: string;
    created_at: Date;
    last_used_at: Date | null;
    expires_at: Date | null;
    revoked_at: Date | null;
  }>(
    `SELECT id, workspace_id, principal_id, name, container_id, prefix, created_at,
            last_used_at, expires_at, revoked_at
       FROM api_tokens WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    name: row.name,
    containerId: row.container_id,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * Revoking stamps the row rather than deleting it.
 *
 * The account, its membership and its grants are left alone deliberately: the
 * activity log points at the principal, and deleting it would turn every row it
 * wrote into a uuid nobody can resolve. A revoked token's principal keeps its
 * name for the same reason a deactivated person does (D-083).
 */
export async function revokeApiToken(
  tokenId: string,
  workspaceId: string,
  context: ConfigContext,
): Promise<void> {
  await inTransaction(context, async (client) => {
    const revoked = await client.query<{ name: string; prefix: string; container_id: string }>(
      `UPDATE api_tokens SET revoked_at = now()
        WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
        RETURNING name, prefix, container_id`,
      [tokenId, workspaceId],
    );

    const row = revoked.rows[0];
    if (!row) return;

    // Against the container it was minted on, symmetric with its creation —
    // the same place the sharing screen's own history lands.
    await logConfigChange(client, {
      workspaceId,
      actorId: context.actorId,
      objectKind: "container",
      objectId: row.container_id,
      verb: "api_token.revoked",
      oldValue: { name: row.name, prefix: row.prefix },
    });
  });
}
