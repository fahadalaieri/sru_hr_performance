import { defineConfig } from "vitest/config";

/**
 * Integration tests: real Postgres (RLS simulated with SET ROLE + a JWT
 * claim, exactly as every migration in this repo was verified by hand), the
 * real Supabase Admin API for fixtures, and — when INTEGRATION_BASE_URL is
 * set — the running Next.js dev server for Route Handlers.
 *
 * Run with `npm run test:integration` against a DEVELOPMENT database only.
 * Fixtures are created with clearly marked `tmp-it-*` emails and deleted by
 * exact id afterwards; nothing here should ever point at production.
 *
 * Reads `.env.local` itself (tests/integration/env.ts) — Vitest does not load
 * it, and this project deliberately has no dotenv dependency.
 */
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["tests/integration/env.ts"],
    pool: "threads",
    // One file at a time: they share one database and real auth users.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
