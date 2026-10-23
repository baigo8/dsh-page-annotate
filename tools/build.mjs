/**
 * Assemble `lib/client.js` from the readable sources.
 *
 * The client bundle format is not a module format — it is the loader envelope
 * every DSH client plugin ships:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } });
 *
 * The factory body is CommonJS-ish: it declares `module`/`exports` itself and
 * pulls React through `require`. Two things make this build non-trivial:
 *
 * 1. `src/core.mjs` is shared. It is concatenated *inside* the factory, so its
 *    helpers are in the client's lexical scope, and the same text is embedded
 *    as a string for the overlay so the injected copy works on the same logic.
 * 2. `src/overlay.js` must run inside the previewed page, not in the shell.
 *    It cannot be `require`d there, so it is embedded as a string and spliced
 *    into the document at runtime by `withOverlay`.
 *
 * No bundler and no TypeScript: the sources are the shipped shape, so a rebuild
 * is a concatenation and this file stays the single source of truth.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const srcDir = join(root, "src");

const PACKAGE_ID = "dsh-page-annotate";
const CLIENT_OUT = join(root, "lib", "client.js");

/**
 * Read one source file.
 * @param {string} name - file name under `src/`.
 * @returns the file text.
 */
async function readSource(name) {
  return await readFile(join(srcDir, name), "utf8");
}

/**
 * `src/core.mjs` uses ESM `export` for the benefit of `node --test`; inside the
 * factory it is plain declarations. Rewriting the two keywords is enough and
 * keeps one authored copy of the logic.
 * @param {string} text - the core module text.
 * @returns the factory-scoped declarations.
 */
function stripModuleSyntax(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*\/\/#\s*sourceMappingURL=/.test(line))
    .map((line) => line.replace(/^export\s+(async\s+function|const|let|var|function)\s/, "$1 "))
    .filter((line) => !/^export\s*\{/.test(line) && !/^import\s/.test(line))
    .join("\n");
}

/**
 * Escape text for embedding inside a double-quoted JavaScript string.
 * @param {string} text - the text to embed.
 * @returns the escaped literal body.
 */
function toJsString(text) {
  return JSON.stringify(text);
}

/**
 * Compose the bundle text.
 * @param {object} parts - the authored pieces.
 * @param {string} parts.core - core logic, already module-stripped.
 * @param {string} parts.overlay - overlay program.
 * @param {string} parts.client - the factory body.
 * @param {string} [parts.map] - optional source map comment.
 * @returns the bundle file text.
 */
function compose(parts) {
  const overlayProgram = `${parts.core}\n${parts.overlay}`;
  // A replacer *function*: the embedded program is full of `$`-sequences, which
  // a string replacement would read as `$&`/`$'` patterns and corrupt.
  const client = parts.client.replace(
    /const OVERLAY_SOURCE = typeof __DPA_OVERLAY__ === "string" \? __DPA_OVERLAY__ : "";/,
    () => `const OVERLAY_SOURCE = ${toJsString(overlayProgram)};`
  ).replace(
    /const CAPTURE_SOURCE = typeof __DPA_CAPTURE__ === "string" \? __DPA_CAPTURE__ : "";/,
    () => `const CAPTURE_SOURCE = ${toJsString(parts.captureVendor)};`
  );
  // A visible build stamp: after a hot reload it is otherwise impossible to tell
  // this bundle from the previous one, which turns "did the fix land?" into
  // guesswork.
  // Local wall-clock, not UTC: this stamp is compared against the clock on the
  // wall, so an 8-hour offset would read as the wrong build.
  const at = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  const built = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return [
    "window.__ModuleLoader__.load({",
    `\tid: ${toJsString(PACKAGE_ID)},`,
    "\tfactory: (require) => {",
    "\t\tvar module = { exports: {} };",
    "\t\tvar exports = module.exports;",
    '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });',
    '\t\tlet react = require("react");',
    `\t\tconst BUILD_STAMP = ${toJsString(built)};`,
    "",
    "\t\t//#region src/core.mjs",
    parts.core.trim(),
    "\t\t//#endregion",
    parts.capture.trim(),
    parts.message.trim(),
    parts.snapshots.trim(),
    "",
    "\t\t//#region src/client.factory.js",
    client.trim(),
    "\t\t//#endregion",
    "",
    "\t\texports.apply = apply;",
    "\t\texports.inject = inject;",
    "\t\treturn module.exports;",
    "\t}",
    "});",
    "",
    "//# sourceMappingURL=client.js.map",
    ""
  ].join("\n");
}

/** Build `lib/client.js` and the overlay artifact used by the tests. */
async function main() {
  const [coreRaw, overlay, client, captureRaw, captureVendor, messageRaw, snapshotsRaw] = await Promise.all([
    readSource("core.mjs"),
    readSource("overlay.js"),
    readSource("client.factory.js"),
    readSource("capture.mjs"),
    readFile(join(root, "vendor", "html2canvas.min.js"), "utf8"),
    readSource("message.mjs"),
    readSource("snapshots.mjs")
  ]);
  const core = stripModuleSyntax(coreRaw);
  const parts = { core, overlay, client, capture: stripModuleSyntax(captureRaw), captureVendor, message: stripModuleSyntax(messageRaw), snapshots: stripModuleSyntax(snapshotsRaw) };
  if (/^\s*export\b/m.test(core)) throw new Error("core.mjs still carries module syntax after stripping");
  if (/__DPA_OVERLAY__/.test(compose(parts))) {
    throw new Error("client factory kept __DPA_OVERLAY__; the OVERLAY_SOURCE line changed shape");
  }
  await mkdir(dirname(CLIENT_OUT), { recursive: true });
  await writeFile(CLIENT_OUT, compose(parts), "utf8");
  console.log(`built ${relative(root, CLIENT_OUT)} (${(await readFile(CLIENT_OUT)).length} bytes)`);
}

await main();
