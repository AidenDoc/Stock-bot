// ============================================================
// ONE-TIME MIGRATION — tag legacy records exitRegime: V1_WEEKLY
// Run with: npm run migrate:regime
// ------------------------------------------------------------
// Stamps every existing record in portfolio.json, scorecard.json
// and trade-memory.json that has no exitRegime yet. Nothing else
// about a legacy record is touched. Idempotent: already-tagged
// records are skipped, so re-running is always safe. Readers also
// treat a MISSING tag as V1_WEEKLY (see tradePlan.regimeOf), so a
// file this script never reached still behaves correctly.
// ============================================================

import fs from 'fs';
import path from 'path';

const V1 = 'V1_WEEKLY';
const DATA = path.join(process.cwd(), 'data');

// Tag every object in `records` lacking exitRegime; returns how many changed.
function tagAll(records: any[]): number {
  let tagged = 0;
  for (const r of records) {
    if (r && typeof r === 'object' && r.exitRegime == null) {
      r.exitRegime = V1;
      tagged++;
    }
  }
  return tagged;
}

// Atomic tmp+rename, same pattern as every other writer in this repo.
function saveJSON(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function migrateFile(name: string, pick: (parsed: any) => any[] | null): void {
  const file = path.join(DATA, name);
  if (!fs.existsSync(file)) {
    console.log(`[Migrate] ${name}: not present — skipped`);
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err: any) {
    console.error(`[Migrate] ${name}: unreadable (${err?.message}) — left untouched`);
    return;
  }
  const records = pick(parsed);
  if (!Array.isArray(records)) {
    console.error(`[Migrate] ${name}: unexpected shape — left untouched`);
    return;
  }
  const tagged = tagAll(records);
  if (tagged > 0) {
    saveJSON(file, parsed);
    console.log(`[Migrate] ${name}: tagged ${tagged} record(s) ${V1} (${records.length - tagged} already tagged)`);
  } else {
    console.log(`[Migrate] ${name}: all ${records.length} record(s) already tagged — no changes`);
  }
}

console.log('[Migrate] Tagging legacy records exitRegime: V1_WEEKLY ...');
migrateFile('portfolio.json', p => (Array.isArray(p) ? p : null));
migrateFile('scorecard.json', p => (Array.isArray(p?.graded) ? p.graded : null));
migrateFile('trade-memory.json', p => (Array.isArray(p?.records) ? p.records : null));
console.log('[Migrate] Done.');
