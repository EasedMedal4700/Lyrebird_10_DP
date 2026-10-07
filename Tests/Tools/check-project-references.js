// Lyrebird_10_DP - offline check that the SAVED project has no missing-file references.
// Usage (from the project folder): node Tests/Tools/check-project-references.js
// Checks project.json (main file, entry points, registered test cases) and every
// WorkflowFileName in every .xaml. Exit code 1 when something is missing.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..", "..");
const norm = (p) => p.split(String.fromCharCode(92)).join("/");
const exists = (rel) => fs.existsSync(path.join(root, norm(rel)));
const problems = [];

const project = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
if (!exists(project.main)) problems.push(`project.json main '${project.main}' is missing`);
for (const e of project.entryPoints || []) if (!exists(e.filePath)) problems.push(`entry point '${e.filePath}' is missing`);
const tests = (project.designOptions && project.designOptions.fileInfoCollection) || [];
for (const t of tests) {
  if (!exists(t.fileName)) problems.push(`registered test case '${t.fileName}' is missing`);
  if (!/^Tests[\\/]/.test(t.fileName)) problems.push(`registered test case '${t.fileName}' has no folder separator`);
}

const skip = new Set([".git", ".local", ".settings", ".objects", ".entities", ".templates", ".tmh", ".storage", "node_modules"]);
const xamls = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!skip.has(entry.name)) walk(path.join(dir, entry.name)); }
    else if (entry.name.endsWith(".xaml")) xamls.push(path.join(dir, entry.name));
  }
})(root);
let invokes = 0;
for (const file of xamls) {
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/WorkflowFileName="([^"\[]+)"/g)) {
    invokes++;
    if (!exists(m[1])) problems.push(`${path.relative(root, file)} invokes missing '${m[1]}'`);
  }
}
const unregistered = xamls.map(f => norm(path.relative(root, f)))
  .filter(f => /^Tests\/[^/]+TestCase\.xaml$/.test(f) && !tests.some(t => norm(t.fileName) === f));

console.log(`main ${project.main}; ${(project.entryPoints || []).length} entry point(s); ${tests.length} registered test case(s); ${xamls.length} workflow file(s); ${invokes} Invoke Workflow path(s).`);
if (unregistered.length) console.log("not registered as test cases (informational): " + unregistered.join(", "));
if (problems.length) { console.log("MISSING:\n- " + problems.join("\n- ")); process.exitCode = 1; }
else console.log("OK: no missing-file references.");
