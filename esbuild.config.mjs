import esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const production = process.argv[2] === "production";
const root = dirname(fileURLToPath(import.meta.url));
const vaultPluginDir = resolve(root, "../native-pdf-handwriting");

function normalizePdfJsBundleWhitespace() {
  const output = resolve(root, "main.js");
  const unstable = "e+=s.deleted?\"f\":\"n\",e+=` \n`}}return e";
  const stable = "e+=s.deleted?\"f\":\"n\",e+=`\\x20\n`}}return e";
  const bundle = readFileSync(output, "utf8");
  if (bundle.includes(unstable)) writeFileSync(output, bundle.replaceAll(unstable, stable));
}

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
          normalizePdfJsBundleWhitespace();
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
