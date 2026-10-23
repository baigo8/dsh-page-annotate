/**
 * Packaging contract.
 *
 * These are the parts that only break for *other people*: a manifest that the
 * plugin manager refuses, a patch file that is not in the tarball, or an
 * `exports` map that hides `locale/*` so the Plugins page falls back to the
 * bare package name. None of it is visible from the running app on the machine
 * that already has a hand-wired profile, which is exactly why it is tested.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

test("the manifest declares a bundle patch, or the plugin manager refuses the install", () => {
  // dsh-plugin-manager refuses with "这个包没有声明组合包" without this, and a
  // plain dependency never becomes a profile layer.
  assert.equal(typeof manifest.dsh?.bundle?.patch, "string");
  assert.ok(existsSync(fileURLToPath(new URL(manifest.dsh.bundle.patch, root))), "the declared patch file exists");
});

test("the declared patch file inserts this package's own row", async () => {
  const text = await readFile(new URL(manifest.dsh.bundle.patch, root), "utf8");
  // A tiny YAML reader: the file is ours, and adding a YAML dependency to
  // assert three lines would be worse than pinning the shape.
  assert.match(text, /- insert:/);
  assert.match(text, new RegExp(`name:\\s*${manifest.name}\\b`));
  const id = /- id:\s*(\S+)/.exec(text)?.[1];
  assert.ok(id !== undefined && id !== "", "the row carries an id");
});

test("the bundle patch ships inside the published files", () => {
  const files = manifest.files ?? [];
  const patch = manifest.dsh.bundle.patch.replace(/^\.\//, "");
  assert.ok(files.includes(patch), `${patch} is in "files"`);
  assert.ok(files.includes("lib"), "lib is published");
});

test("locale metadata ships and is reachable through the exports map", () => {
  // Node's `exports` is an allow-list: without "./locale/*" the Host's
  // readPluginMeta cannot read locale/en.json, and the Plugins page shows the
  // package name instead of the translated title.
  const files = manifest.files ?? [];
  assert.ok(files.includes("locale"), "locale/ is published");
  assert.ok(files.includes("lib/client.js") === false, "lib/client.js is covered by the lib directory");
  const paths = Object.keys(manifest.exports ?? {});
  assert.ok(paths.includes("./locale/*"), 'exports allows "./locale/*"');
});

test("locale metadata carries both languages and a title in each", async () => {
  for (const language of ["en", "zh"]) {
    const raw = await readFile(new URL(`locale/${language}.json`, root), "utf8");
    const parsed = JSON.parse(raw);
    assert.equal(typeof parsed.meta?.title, "string");
    assert.equal(typeof parsed.meta?.description, "string");
    assert.ok(parsed.meta.title.trim() !== "" && parsed.meta.description.trim() !== "");
  }
  const zh = JSON.parse(await readFile(new URL("locale/zh.json", root), "utf8"));
  assert.match(zh.meta.title, /[\u4e00-\u9fa5]/, "the Chinese title is actually Chinese");
  assert.match(zh.meta.description, /[\u4e00-\u9fa5]/);
});

test("the client bundle export and dsh.client stay declared", () => {
  assert.equal(typeof manifest.exports?.["./client"]?.default, "string");
  assert.equal(manifest.dsh.client.platform, "web");
  assert.ok(Array.isArray(manifest.dsh.client.inject) && manifest.dsh.client.inject.length > 0);
});
