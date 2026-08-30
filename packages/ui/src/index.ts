/**
 * Screens import from `@arbor/ui`, never from the registry directly.
 * That single indirection keeps re-skinning the whole app a one-package change.
 *
 * Primitives sourced from 21st.dev land in ./primitives via:
 *   npx shadcn@latest add "https://21st.dev/r/<author>/<component>"
 * and every import is recorded in ATTRIBUTIONS.md.
 */
export {};
