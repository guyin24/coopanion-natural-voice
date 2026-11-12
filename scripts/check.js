import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import definition from "../src/index.js";

const root = fileURLToPath(new URL("../", import.meta.url));
function checkFolder(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) checkFolder(path);
    else if (entry.name.endsWith(".js"))
      execFileSync(process.execPath, ["--check", path]);
  }
}
for (const folder of ["src", "full", "web", "scripts", "tests"])
  checkFolder(join(root, folder));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.ok(typeof pkg.description === "string" && pkg.description.length <= 255, "npm truncates market descriptions beyond 255 characters");
assert.equal(pkg.description, pkg.cortico.locales.zh.description, "Default and Chinese market descriptions must agree");
for (const path of [
  pkg.main,
  pkg.cortico.webUiClient,
  pkg.cortico.webUiStyle,
  pkg.cortico.describe,
]) {
  assert.ok(existsSync(resolve(root, path)), `Missing package entry: ${path}`);
}
const instance = definition.create({ cfg: definition.defaults(), secret: () => "", storeSecret() {} });
const seenPromptKeys = new Set();
const prompts = (instance.webUi("zh").promptDocs ?? [])
  .filter((doc) => {
    if (doc.role !== "envPrompt" || seenPromptKeys.has(doc.key) || !existsSync(doc.path)) return false;
    seenPromptKeys.add(doc.key);
    return true;
  })
  .map((doc) => ({ key: doc.key, title: doc.title, role: doc.role, content: readFileSync(doc.path, "utf8").replace(/^\uFEFF/, "") }));
const expectedDescription = prompts.length ? { ...definition.describe, prompts } : definition.describe;
assert.deepEqual(expectedDescription, JSON.parse(readFileSync(join(root, "describe.json"), "utf8")));
console.log("Syntax, package entry files and describe.json passed.");
