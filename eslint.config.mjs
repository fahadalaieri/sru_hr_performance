import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone reference/inspiration file, not part of the app — see
    // HANDOVER.md: built in a separate React sandbox, never integrated
    // into src/app, never run in a browser.
    "docs/archive/hr_performance_dashboard.jsx",
  ]),
]);

export default eslintConfig;
