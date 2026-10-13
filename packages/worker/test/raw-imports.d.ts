/**
 * Vite's `?raw` import, so a test can read the module it is testing as text.
 *
 * Its own file, with no top-level import or export: a `declare module` inside a file
 * that is itself a module is an augmentation of that specifier, not the global wildcard
 * this needs to be. The workers pool has no filesystem, so `readFileSync` is not an
 * option here.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}

/**
 * `import.meta.glob`, Vite's build-time directory read.
 *
 * `test/support/migrate.ts` inlines every file in `migrations/` through it, so the suite
 * runs against the SQL the worker actually ships rather than a hand-copied subset. The
 * workers pool has no filesystem, so this is the only way to read a directory at all, and
 * the `types` list in tsconfig is workers + the pool, neither of which declares Vite's
 * additions to `ImportMeta`.
 */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string | string[],
    options?: {
      query?: string;
      import?: string;
      eager?: boolean;
      as?: string;
    },
  ): Record<string, T>;
}
