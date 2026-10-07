// Lyrebird_10_DP - Main.xaml integration tests (step 3).
// Runs Main.xaml against the dedicated queues Lyrebird_Validate_Main_IT / Lyrebird_Wishlist_Main_IT
// with marked test rows (message 'LYREBIRD_IT MAIN ...'), and checks wishlist rows and queue items.
//
// Usage (from the project folder; needs `uip` from %APPDATA%\npm, node, and `ssh tower` for the database):
//   node Tests/MainIntegration/main-it.js run       -> inserts its own test rows, runs all scenarios, writes main-it-report.json
//   node Tests/MainIntegration/main-it.js cleanup   -> deletes the rows recorded in main-it-state.json and every item of the two _Main_IT queues
//
// Safety: refuses unless both queues end with _Main_IT; Main itself refuses _IT input with a non-_IT output
// (BuildRunSettings) and in test mode loads ONLY rows whose message starts with LYREBIRD_IT, further limited
// by in_LoadFilter to the ids this script inserted. Original wishlist rows are never read for writing.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT = path.resolve(__dirname, "..", "..");
const STATE = path.join(__dirname, "main-it-state.json");
const REPORT = path.join(__dirname, "main-it-report.json");
const FOLDER = "Lyrebird";
const VQ = "Lyrebird_Validate_Main_IT";
const WQ = "Lyrebird_Wishlist_Main_IT";
const MARK = "LYREBIRD_IT MAIN";
const CLI = path.join(process.env.APPDATA, "npm", "node_modules", "@uipath", "cli", "dist", "index.js");
if (!VQ.endsWith("_Main_IT") || !WQ.endsWith("_Main_IT")) throw new Error("refused: queues must end with _Main_IT");

// ---------- helpers ----------
function sql(text) {
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "tower", "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -At -F '|'"],
    { input: text, encoding: "utf8" });
  if (r.status !== 0) throw new Error("SQL failed: " + (r.stderr || r.stdout));
  return r.stdout.trim();
}
function uip(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: PROJECT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(r.stdout); } catch { return { Result: "Unparsed", raw: (r.stdout || "") + (r.stderr || "") }; }
}
function runMain(args) {
  const file = path.join(__dirname, "main-args.tmp.json");
  fs.writeFileSync(file, JSON.stringify(Object.assign({
    in_OrchestratorQueueName: VQ, in_OrchestratorQueueFolder: FOLDER, in_WishlistQueueName: WQ,
  }, args)));
  const started = Date.now();
  const r = uip(["rpa", "run", "--file-path", "Main.xaml", "--project-dir", ".", "--skip-build", "--input-arguments-file", file, "--output", "json"]);
  fs.unlinkSync(file);
  const d = r.Data || {};
  const logs = (d.logEntries || []).map(e => e.message || "");
  const errors = (d.errors || []).map(e => (e.errorName || "") + ": " + (e.errorMessage || ""));
  return { seconds: Math.round((Date.now() - started) / 1000), logs, errors, faulted: errors.length > 0 };
}
function queueItems(queue) {
  const r = uip(["or", "queue-items", "list", "--folder-path", FOLDER, "--queue-name", queue, "--limit", "100", "--all-fields", "--output", "json"]);
  if (r.Result !== "Success") throw new Error("queue list failed: " + JSON.stringify(r).slice(0, 300));
  return r.Data.filter(i => i.Status !== "Deleted");
}
// Orchestrator lists status changes with a short delay: wait until no item of the given rows is New/InProgress-in-flux
function settled(queue, ids, allowNew) {
  for (let i = 0; i < 20; i++) {
    const items = queueItems(queue);
    const busy = items.filter(x => ids.includes(Number(x.SpecificContent && x.SpecificContent.WishlistId)) && (x.Status === "InProgress" || (!allowNew && x.Status === "New")));
    if (!busy.length) return items;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return queueItems(queue);
}
const earlier = (x) => x.status === "Retried" || x.status === "Failed"; // a failed attempt shows as Retried once Orchestrator created its retry
function itemsFor(items, id) {
  return items.filter(i => i.SpecificContent && Number(i.SpecificContent.WishlistId) === id)
    .sort((a, b) => a.Id - b.Id)
    .map(i => ({ status: i.Status, retry: i.RetryNumber, ref: i.Reference, output: i.Output || null,
                 exception: i.ProcessingExceptionType || (i.ProcessingException && i.ProcessingException.Type) || null,
                 reason: (i.ProcessingException && i.ProcessingException.Reason) || null,
                 details: (i.ProcessingException && i.ProcessingException.Details) || null }));
}
function row(id) {
  const out = sql(`select row_to_json(w) from lyrebird.wishlist w where id = ${Number(id)};`);
  return out ? JSON.parse(out) : null;
}
function insertRows(rows) {
  const values = rows.map(r => `(${q(r.artist)}, ${q(r.album)}, 'FLAC', ${r.chosen ? q(r.chosen) + "::uuid" : "null"}, ${q(MARK + " " + r.tag + " " + new Date().toISOString().slice(0, 10))})`).join(",\n");
  const out = sql(`insert into lyrebird.wishlist (artist, album, preferred_format, chosen_release_id, message) values\n${values}\nreturning id;`);
  return out.split(/\r?\n/).map(Number);
}
function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function loadState() { return fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { rows: [] }; }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
const results = [];
function check(scenario, name, ok, evidence) {
  results.push({ scenario, name, ok: !!ok, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} [${scenario}] ${name}${evidence ? " :: " + JSON.stringify(evidence).slice(0, 400) : ""}`);
}
const has = (logs, text) => logs.some(l => l.includes(text));
const count = (logs, re) => logs.filter(l => re.test(l)).length;

// ---------- scenarios ----------
function run() {
  const state = loadState();
  const before = queueItems(VQ).length + queueItems(WQ).length;
  if (before > 0) throw new Error(`refused: ${VQ}/${WQ} must be empty before a run (found ${before} active items); run cleanup first`);

  const ids = insertRows([
    { tag: "S1 queued", artist: "Massive Attack", album: "Mezzanine", chosen: "5ddf4fbc-c415-4974-9d2b-abb7b96b45f7" },
    { tag: "S1 not_found", artist: "Lyrebird Integration Test", album: "No Such Album Main 20261007" },
    { tag: "S1 check_spelling", artist: "Portisead", album: "Dumy" },
    { tag: "S1 business rejection", artist: "Lyrebird Integration Test", album: "Business Rejection Main 20261007" },
    { tag: "S3 technical retry", artist: "Air", album: "Moon Safari", chosen: "4c55906c-349b-362d-922e-956762912b42" },
    { tag: "S4 exhausted with download item", artist: "Björk", album: "Homogenic", chosen: "b0b0473a-e3ea-49b5-a332-5e2106317d74" },
    { tag: "S5 exhausted without download item", artist: "Portishead", album: "Dummy", chosen: "8f468f36-8c7e-4fc1-9166-50664d267127" },
  ]);
  state.rows.push(...ids); state.since = state.since || new Date(Date.now() - 60000).toISOString(); saveState(state);
  const [A, B, C, E, F, G, H] = ids;
  console.log("test rows", { A, B, C, E, F, G, H });

  // S0: unsafe settings are refused before anything is loaded
  let m = runMain({ in_WishlistQueueName: "", in_LoadFilter: `id=in.(${A})` });
  check("S0 unsafe settings", "test input with the regular output queue faults the job", m.faulted && m.errors.some(e => e.includes("requires a test output queue")), m.errors);
  check("S0 unsafe settings", "nothing was loaded", queueItems(VQ).length === 0 && !row(A).queue_reference, { items: queueItems(VQ).length });

  // S1 setup: load E alone, then break its stored reference -> its item must be rejected (business)
  const pre = uip(["rpa", "run", "--file-path", "Workflows/Wishlist/LoadNewWishlistItems.xaml", "--project-dir", ".", "--skip-build",
    "--input-arguments", `in_QueueName=${VQ}`, "--input-arguments", `in_QueueFolder=${FOLDER}`,
    "--input-arguments", `in_Query=select=*&id=eq.${E}`, "--output", "json"]);
  check("S1 setup", "row E loaded alone", pre.Result === "Success" && !!row(E).queue_reference, row(E).queue_reference);
  sql(`update lyrebird.wishlist set queue_reference = 'Changed By Test - Elsewhere | WL-${E}-S1' where id = ${E} and message like 'LYREBIRD_IT%';`);

  // S1: startup load + success outcomes + business rejection, one job
  m = runMain({ in_LoadFilter: `id=in.(${A},${B},${C})` });
  const v1 = settled(VQ, [A, B, C, E]), w1 = queueItems(WQ);
  check("S1 success/business", "job ended without fault", !m.faulted, m.errors);
  check("S1 success/business", "startup load added A, B, C once", has(m.logs, "Startup load into") && m.logs.some(l => /Startup load into .*: 3 added/.test(l)), m.logs.filter(l => l.includes("Startup load")));
  const out = (id) => itemsFor(v1, id);
  check("S1 success/business", "A queued -> Successful, Output Outcome=queued, one download item",
    out(A).length === 1 && out(A)[0].status === "Successful" && out(A)[0].output && out(A)[0].output.Outcome === "queued" && row(A).status === "queued" && itemsFor(w1, A).length === 1, { item: out(A), row: row(A).status });
  check("S1 success/business", "B not_found -> Successful", out(B).length === 1 && out(B)[0].status === "Successful" && out(B)[0].output.Outcome === "not_found" && row(B).status === "not_found", out(B));
  check("S1 success/business", "C check_spelling -> Successful", out(C).length === 1 && out(C)[0].status === "Successful" && out(C)[0].output.Outcome === "check_spelling" && row(C).status === "check_spelling", out(C));
  check("S1 success/business", "E business rejection -> Failed once, no retry, row untouched",
    out(E).length === 1 && out(E)[0].status === "Failed" && out(E)[0].retry === 0 && row(E).status === "new" && !row(E).mbid, { item: out(E), row: row(E).status });
  check("S1 success/business", "MusicBrainz spacing kept across transactions", count(m.logs, /MusicBrainz: waiting \d+ ms/) >= 1, m.logs.filter(l => l.includes("MusicBrainz: waiting")).slice(0, 4));

  // S2: empty queue
  m = runMain({ in_LoadFilter: "id=in.(-1)" });
  check("S2 empty queue", "job ends cleanly without a transaction", !m.faulted && has(m.logs, "no more transaction data") && !m.logs.some(l => /^Process .*: attempt/.test(l)),
    m.logs.filter(l => /no more transaction|Startup load/.test(l)));

  // S3: technical failure on attempt 1 + stop after 1 transaction, then restart without injection
  m = runMain({ in_LoadFilter: `id=in.(${F})`, in_TestFailAfterStep: "after_enqueue", in_MaxTransactions: 1 });
  let v = settled(VQ, [F], true);
  check("S3 retry/restart", "run 1: attempt 1 failed (Application), retry item New, stopped by the limit",
    !m.faulted && itemsFor(v, F).length === 2 && earlier(itemsFor(v, F)[0]) && itemsFor(v, F)[0].exception === "ApplicationException" && itemsFor(v, F)[1].status === "New" && itemsFor(v, F)[1].retry === 1 && has(m.logs, "Transaction limit 1 reached"), itemsFor(v, F));
  check("S3 retry/restart", "run 1: row still new with reservation, download item exists", row(F).status === "new" && !!row(F).reserved_release_group && itemsFor(queueItems(WQ), F).length === 1, { status: row(F).status, rsv: row(F).reserved_release_group });
  m = runMain({ in_LoadFilter: `id=in.(${F})` });
  v = settled(VQ, [F]);
  check("S3 retry/restart", "run 2 (restart): no new Validate item, retry recovered to queued, still one download item",
    !m.faulted && m.logs.some(l => /Startup load into .*: 0 added, 1 already queued/.test(l)) && itemsFor(v, F).length === 2 && itemsFor(v, F)[1].status === "Successful" && row(F).status === "queued" && itemsFor(queueItems(WQ), F).length === 1,
    { items: itemsFor(v, F), row: row(F).status, load: m.logs.filter(l => l.includes("Startup load")) });

  // S4: every attempt fails after enqueue -> last attempt reconciles from the download item
  const s4 = [];
  for (let i = 0; i < 4; i++) {
    m = runMain({ in_LoadFilter: `id=in.(${G})`, in_TestFailAfterStep: "after_enqueue" });
    s4.push(...m.logs);
    if (!settled(VQ, [G], true).some(x => x.Status === "New")) break;
  }
  v = settled(VQ, [G]);
  check("S4 exhausted + item", "3 attempts (Application), the last one Failed with no retry left", itemsFor(v, G).length === 3 && itemsFor(v, G).every(earlier) && itemsFor(v, G).every(x => x.exception === "ApplicationException") && itemsFor(v, G)[2].status === "Failed" && itemsFor(v, G)[2].retry === 2, itemsFor(v, G));
  check("S4 exhausted + item", "row finished as queued from the item, reservation kept, one download item",
    row(G).status === "queued" && !!row(G).reserved_release_group && itemsFor(queueItems(WQ), G).length === 1 && s4.some(l => l.includes("recovered_queued")), { status: row(G).status, rsv: row(G).reserved_release_group });
  check("S4 exhausted + item", "re-initialization did not load again", s4.some(l => l.includes("Startup load already ran in this job")), s4.filter(l => l.includes("Startup load")).slice(0, 4));

  // S5: every attempt fails after the reservation -> nothing queued -> reservation released, row failed TECHNICAL
  const s5 = [];
  for (let i = 0; i < 4; i++) {
    m = runMain({ in_LoadFilter: `id=in.(${H})`, in_TestFailAfterStep: "after_reservation" });
    s5.push(...m.logs);
    if (!settled(VQ, [H], true).some(x => x.Status === "New")) break;
  }
  v = settled(VQ, [H]);
  check("S5 exhausted, no item", "3 attempts (Application), the last one Failed with no retry left", itemsFor(v, H).length === 3 && itemsFor(v, H).every(earlier) && itemsFor(v, H)[2].status === "Failed" && itemsFor(v, H)[2].retry === 2, itemsFor(v, H));
  check("S5 exhausted, no item", "row failed (TECHNICAL), reservation released, no download item",
    row(H).status === "failed" && /^TECHNICAL:/.test(row(H).message || "") && !row(H).reserved_release_group && itemsFor(queueItems(WQ), H).length === 0 && s5.some(l => l.includes("released_failed")),
    { status: row(H).status, msg: (row(H).message || "").slice(0, 120), rsv: row(H).reserved_release_group });
  check("S5 exhausted, no item", "MusicBrainz last-request time survives re-initialization (retries see the earlier request)",
    count(s5, /: attempt [23].*last MusicBrainz request \d\d:\d\d:\d\d\.\d{3} UTC/) >= 2, s5.filter(l => /: attempt \d.*last MusicBrainz request/.test(l)));

  // technical-error handling: text only, no desktop screenshots
  const last = itemsFor(v, H)[2] || {};
  check("Error handling", "system exceptions are recorded as sanitized text (reason 'Type: message', details = exception type)",
    /^Exception: INJECTED FAILURE/.test(last.reason || "") && /System\.Exception/.test(last.details || ""), { reason: (last.reason || "").slice(0, 120), details: last.details });
  check("Error handling", "no screenshot folder was created", !fs.existsSync(path.join(PROJECT, "Exceptions_Screenshots")), null);

  const failed = results.filter(r => !r.ok).length;
  fs.writeFileSync(REPORT, JSON.stringify({ when: new Date().toISOString(), rows: { A, B, C, E, F, G, H }, failed, results }, null, 2));
  console.log(`\n${results.length - failed}/${results.length} checks passed; report ${path.relative(PROJECT, REPORT)}`);
  process.exitCode = failed ? 1 : 0;
}

function cleanup() {
  const state = loadState();
  for (const queue of [VQ, WQ]) {
    for (const i of queueItems(queue)) {
      const r = uip(["or", "queue-items", "delete", i.UniqueKey || i.Key, "--folder-path", FOLDER, "--yes", "--output", "json"]);
      console.log(`delete ${queue} ${i.Reference} [${i.Status}] -> ${r.Result}`);
    }
  }
  if (state.rows.length) {
    // processed rows no longer carry the LYREBIRD_IT message (the performer overwrites it): match the ids this script inserted AND their creation time
    const out = sql(`delete from lyrebird.wishlist where id in (${state.rows.map(Number).join(",")}) and created_at >= ${q(state.since)}::timestamptz returning id;`);
    console.log("deleted rows:", out.replace(/\r?\n/g, ","));
  }
  saveState({ rows: [] });
  if (fs.existsSync(REPORT)) console.log("report kept:", path.relative(PROJECT, REPORT));
}

const cmd = process.argv[2];
if (cmd === "run") run();
else if (cmd === "cleanup") cleanup();
else console.log("usage: node Tests/MainIntegration/main-it.js run|cleanup");
