/** @type {import('next').NextConfig} */
const nextConfig = {
  // Workspace packages ship TypeScript source rather than build output, so the
  // app compiles them itself. Keeps `npm run dev` free of a build step.
  transpilePackages: ["@arbor/core", "@arbor/db", "@arbor/ui"],
  // node-postgres must not be bundled into the server build.
  serverExternalPackages: ["pg"],
};

export default nextConfig;
