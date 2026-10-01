/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source rather than build output, so the
  // app compiles them itself. Keeps `npm run dev` free of a build step.
  transpilePackages: ["@arbor/core", "@arbor/db", "@arbor/ui"],
  /**
   * Not bundled into the server build.
   *
   * `pg` because it loads native bindings. **`yjs` because two copies of it is
   * a correctness bug, not a size one** (D-114): `@arbor/core` and `@arbor/db`
   * are both transpiled here and both import it, so bundling gave the server
   * two module instances and Yjs said so on every boot — "Yjs was already
   * imported. This breaks constructor checks". A `Y.Map` made by one copy fails
   * `instanceof` against the other, which in this app means the projection back
   * to a block tree (ADR 6) silently stops recognising its own types. Marking it
   * external makes both packages `require` the one in `node_modules`.
   */
  serverExternalPackages: ["pg", "yjs"],
  /**
   * Traced output, for the container image (D-114).
   *
   * `standalone` copies the server and only the files it actually reaches into
   * `.next/standalone`, which is what lets the runtime image carry no
   * `node_modules` of its own and no build tooling. It changes nothing about
   * `next dev` — it is a `next build` concern only.
   */
  output: "standalone",
  /**
   * The monorepo root, so tracing follows `@arbor/*` out of `apps/web`.
   *
   * Without it Next traces from the app directory, misses the workspace
   * packages above it, and produces a standalone build that cannot start.
   */
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
};

export default nextConfig;
