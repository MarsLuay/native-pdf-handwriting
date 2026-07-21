import obsidianmd from "eslint-plugin-obsidianmd";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "node_modules",
    "dist",
    "main.js",
    "src/vendor/**",
  ]),
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts", "src/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // recommended 0.4.1 turns this off; keep it on for popout-window safety + code-analysis policy.
      "obsidianmd/prefer-active-doc": "error",
      "obsidianmd/prefer-create-el": "error",
      "obsidianmd/settings-tab/prefer-setting-definitions": "error",
      "obsidianmd/settings-tab/no-deprecated-display": "error",
    },
  },
  {
    // Obsidian 1.12.x only paints PluginSettingTab.display(); 1.13+ uses getSettingDefinitions().
    files: ["src/settings.ts"],
    rules: {
      "obsidianmd/settings-tab/no-deprecated-display": "off",
    },
  },
]);
