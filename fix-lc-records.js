// ============================================================
// ONE-OFF DATA FIX — LC → HAPN ticker-change phantom picks
// ------------------------------------------------------------
// LendingClub changed its ticker LC → HAPN effective 2026-06-22.
// The scanner picked the dead LC symbol on 2026-06-22 and 2026-07-06;
// Yahoo served the frozen last trade ($19.21) for both entry and final,
// and both graded as fake flat 0.00% weeks. This script annotates those
// two records with invalid: true so every stats consumer excludes them.
// Records are NOT deleted — they stay as audit history.
//
// Run on the VPS from the repo root:  node fix-lc-records.js
// Then delete the script. Backup written to
// data/scorecard.backup-lc-fix.json before anything is touched.
// ============================================================

const fs = require('fs');
const path = require('path');

const FILE = path.join(process.cwd(), 'data', 'scorecard.json');
const BACKUP = path.join(process.cwd(), 'data', 'scorecard.backup-lc-fix.json');

const TARGET_DATES = ['2026-06-22', '2026-07-06']; // pickedDate (day part)
const FROZEN_FINAL_PRICE = 19.21;
const NOTE = 'Excluded: LC ticker changed to HAPN 2026-06-22; pick made against dead symbol, never tradeable. Frozen quote artifact.';

function fail(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

function stats(graded) {
  const closed = graded.filter(g => g.outcome !== 'OPEN');
  const valid = closed.filter(g => g.invalid !== true);
  const byStrategy = {};
  for (const g of valid) {
    const key = g.strategy || 'n/a';
    byStrategy[key] = (byStrategy[key] || 0) + 1;
  }
  return { totalGraded: closed.length, validGraded: valid.length, byStrategy };
}

function printStats(label, s) {
  console.log(`${label}`);
  console.log(`  total graded: ${s.totalGraded}`);
  console.log(`  valid graded: ${s.validGraded}`);
  const strat = Object.entries(s.byStrategy).map(([k, v]) => `${k}=${v}`).join(', ') || 'none';
  console.log(`  valid by strategy: ${strat}`);
}

// ── Load ──────────────────────────────────────────────────
if (!fs.existsSync(FILE)) fail(`${FILE} not found — run this from the repo root on the VPS.`);
const raw = fs.readFileSync(FILE, 'utf-8');
let history;
try {
  history = JSON.parse(raw);
} catch (e) {
  fail(`data/scorecard.json does not parse: ${e.message}`);
}
if (!Array.isArray(history.graded)) fail('data/scorecard.json has no "graded" array — wrong file?');

// ── Backup (keep the FIRST backup if the script is re-run) ──
if (fs.existsSync(BACKUP)) {
  console.log(`⚠️  Backup already exists at ${BACKUP} — keeping it (not overwriting).`);
} else {
  fs.writeFileSync(BACKUP, raw);
  console.log(`✅ Backed up scorecard to ${BACKUP}`);
}

// ── Before stats ──────────────────────────────────────────
console.log('');
printStats('BEFORE:', stats(history.graded));

// ── Find and annotate the two LC phantom picks ────────────
const matches = history.graded.filter(g =>
  g.ticker === 'LC'
  && g.outcome !== 'OPEN'
  && TARGET_DATES.includes((g.pickedDate || '').slice(0, 10))
  && g.finalPrice === FROZEN_FINAL_PRICE
);

console.log(`\nFound ${matches.length} matching LC record(s) (expected 2):`);
for (const g of matches) {
  console.log(`  - LC ${(g.pickedDate || '').slice(0, 10)} [${g.strategy || 'n/a'}] ` +
    `entry $${g.entryPrice} → final $${g.finalPrice} (${g.outcome})` +
    (g.invalid === true ? '  [already marked invalid]' : ''));
}
if (matches.length === 0) fail('No matching LC records found — nothing changed. Check the file by hand.');
if (matches.length !== 2) {
  console.log(`⚠️  Expected exactly 2 — proceeding with the ${matches.length} found, but eyeball the list above.`);
}

let changed = 0;
for (const g of matches) {
  if (g.invalid === true) continue; // idempotent re-run
  g.invalid = true;
  // Keep the original grading note for the audit trail, exclusion note first.
  g.note = g.note ? `${NOTE} (original note: ${g.note})` : NOTE;
  changed++;
}
console.log(`\nAnnotated ${changed} record(s) with invalid: true.`);

// ── Write + verify ────────────────────────────────────────
fs.writeFileSync(FILE, JSON.stringify(history, null, 2));

let verified;
try {
  verified = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
} catch (e) {
  fail(`data/scorecard.json no longer parses after the write (${e.message}) — restore from ${BACKUP}!`);
}
if (!Array.isArray(verified.graded) || verified.graded.length !== history.graded.length) {
  fail(`Record count changed on rewrite — restore from ${BACKUP}!`);
}

console.log('');
printStats('AFTER:', stats(verified.graded));
console.log('\n✅ Done. JSON re-parsed cleanly; records annotated, not deleted.');
console.log('   You can delete this script now (and keep or remove the backup).');
