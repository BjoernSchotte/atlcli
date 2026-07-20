/**
 * PostCSS config for the extension's Vite/WXT build (spec 010 Phase 0).
 *
 * Tailwind v4 is wired here rather than through `@tailwindcss/vite` in
 * `wxt.config.ts` on purpose: Vite picks this file up automatically, so the
 * UI foundation costs zero changes to the manifest-bearing WXT config (which
 * `tests/manifest.test.ts` asserts verbatim — permissions and CSP must not
 * drift as a side effect of adding a CSS pipeline).
 */
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
