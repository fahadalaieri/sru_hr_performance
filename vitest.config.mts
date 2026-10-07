import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Vitest's default pool is `forks` — a child process per test file. On a
    // loaded Windows machine that spawn is slow enough to hit the pool's
    // "Timeout waiting for worker to respond", and the failure mode is the
    // dangerous kind: the run reports the tests it DID execute as passing and
    // still exits 0, counting the files whose workers never started only as
    // "errors". A run can look green while silently skipping whole test files
    // — which is what happened here on 2026-08-24: 35 of 37 files ran, 7 tests
    // never executed, exit code 0.
    //
    // `threads` shares one process, so there is no per-file spawn to time out.
    // Same suite, same machine: 37/37 files in 47s instead of 35/37 in 136s.
    // Linux CI was never affected — this only makes the local run match what
    // CI has been verifying all along.
    pool: "threads",
    // Integration tests (tests/integration) need a real database and run via
    // `npm run test:integration` with their own config; the default run and
    // CI must never pick them up.
    exclude: ["**/node_modules/**", "**/.next/**", "tests/**"],
  },
});
