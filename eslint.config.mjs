import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma client output.
    "src/generated/**",
  ]),

  {
    rules: {
      /**
       * The React Compiler flags any setState inside an effect. Several of ours
       * are the legitimate forms the rule cannot distinguish: fetch-on-mount,
       * resetting derived state when a filter changes, and advancing the active
       * itinerary stop in response to a GPS event.
       *
       * Demoted to a warning rather than silenced, so the instances stay
       * visible. Converting them to derived values / event handlers is tracked
       * as phase 9 work in ROAMORA_ROADMAP.md; doing it here would mean
       * restructuring verified-working map and routing code with no test
       * coverage behind it yet.
       */
      "react-hooks/set-state-in-effect": "warn",
    },
  },

  {
    // Build scripts run in Node and legitimately use console output.
    files: ["scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
]);

export default eslintConfig;
