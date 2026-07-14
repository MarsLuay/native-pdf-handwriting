import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "node:process";

const production = process.argv[2] === "production";
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
  logLevel: "info"
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
