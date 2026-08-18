/**
 * No-op stand-in for the `server-only` package.
 *
 * That package throws when imported outside a React Server Component, which
 * would fail every test of a server module. The guard it provides is a
 * build-time concern; under Vitest these modules are plain functions.
 */
export {};
