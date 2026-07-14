import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const root = dirname(fileURLToPath(import.meta.url));
const vaultPluginDir = resolve(root, "../../.obsidian/plugins/native-pdf-handwriting");

function deployToVaultPlugin() {
  if (!existsSync(vaultPluginDir)) mkdirSync(vaultPluginDir, { recursive: true });
  for (const file of ["main.js", "manifest.json", "styles.css"]) {
    const from = resolve(root, file);
    if (!existsSync(from)) continue;
    copyFileSync(from, resolve(vaultPluginDir, file));
  }
  console.log(`[deploy] ${vaultPluginDir}`);
}

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
  format: "cjs",
  target: "es2021",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
  logLevel: "info",
  plugins: [{
    name: "deploy-vault-plugin",
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length) return;
        try {
          deployToVaultPlugin();
        } catch (error) {
          console.warn("[deploy] failed:", error);
        }
      });
    }
  }]
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
