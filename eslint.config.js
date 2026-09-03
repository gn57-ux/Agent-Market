import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "contracts/cache/**",
      "contracts/artifacts/**",
      "contracts/typechain-types/**",
      // Pre-built Cocos Creator runtime bundle (Feature 15) — build output
      // copied into apps/web's static assets for iframe serving, not
      // authored source. Same reasoning as contracts/artifacts above: build
      // artifacts are never lint targets, regardless of whether they're
      // currently checked in or eventually become CI-generated (T-1503).
      "apps/web/public/office-cocos/**",
      // Cocos Creator editor-generated directories under
      // apps/office-cocos/ — mirrors apps/office-cocos/.gitignore exactly;
      // none of these are authored, all regenerate on open/build.
      "apps/office-cocos/library/**",
      "apps/office-cocos/temp/**",
      "apps/office-cocos/local/**",
      "apps/office-cocos/build/**",
      "apps/office-cocos/profiles/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },
  {
    // Plain JS/MJS project scripts and configs (e.g. scripts/*.mjs,
    // eslint.config.js itself) run under Node, not the browser.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
);
