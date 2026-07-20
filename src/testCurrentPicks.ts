// ============================================================
// TEST — current-picks.json snapshot
// Builds sample stock picks, writes the snapshot through the real
// atomic writer to a temp path, reads it back, and asserts the
// parsed shape. Also asserts a LEGACY file containing a retired
// option_call entry still parses without throwing (options picks
// were removed July 2026; old files keep those entries).
// Run: npm run test:picks
// ============================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { StockPick, WeeklyReport, TechnicalIndicators } from './types';
import { buildCurrentPicks, writeCurrentPicks } from './currentPicks';

const technicals: TechnicalIndicators = {
  ticker: 'XYZ', rsi: 55, macd: 0.4, macdSignal: 0.3,
  sma20: 41, sma50: 40, sma200: 38, support: 39.5, resistance: 46,
  trend: 'bullish',
};

const pullbackPick: StockPick = {
  ticker: 'XYZ',
  name: 'XYZ Corp',
  pickType: 'STOCK_LONG',
  currentPrice: 42.15,
  entryZone: { low: 41.5, high: 42.5 },
  targetPrice: 46.50,
  stopLoss: 39.80,
  riskRewardRatio: 1.9,
  timeHorizon: '1-2 weeks',
  confidenceScore: 78,
  catalysts: ['Product launch'],
  risks: ['Sector rotation'],
  summary: 'Sample pullback pick',
  technicals,
  news: [],
  sector: 'Technology',
  addedAt: '2026-07-03T12:00:00.000Z',
  strategy: 'PULLBACK',
  earningsGap: { date: '2026-07-10', daysUntil: 7, withinHorizon: true },
};

const breakoutPick: StockPick = {
  ...pullbackPick,
  ticker: 'ABC',
  name: 'ABC Inc',
  currentPrice: 18.40,
  targetPrice: 21.00,
  stopLoss: 17.10,
  summary: 'Sample breakout pick',
  strategy: 'BREAKOUT',
  earningsGap: undefined,
};

const report: WeeklyReport = {
  weekOf: 'July 3, 2026',
  stockPicks: [pullbackPick, breakoutPick],
  marketOutlook: 'test',
  keyEventsThisWeek: [],
  generatedAt: '2026-07-03T12:00:00.000Z',
};

// ── 1. Pure builder produces the expected shape ─────────────
const built = buildCurrentPicks(report);
assert.strictEqual(built.generatedAt, report.generatedAt);
assert.strictEqual(built.scanType, 'weekly');
assert.strictEqual(built.picks.length, 2);

const [pull, brk] = built.picks;
assert.deepStrictEqual(pull, {
  ticker: 'XYZ',
  type: 'swing',
  strategy: 'PULLBACK',
  entryPrice: 42.15,
  target: 46.50,
  stop: 39.80,
  earningsFlag: true,
});
assert.deepStrictEqual(brk, {
  ticker: 'ABC',
  type: 'swing',
  strategy: 'BREAKOUT',
  entryPrice: 18.40,
  target: 21.00,
  stop: 17.10,
  earningsFlag: false,
});

// ── 2. Atomic writer round-trips through the filesystem ─────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'current-picks-test-'));
const target = path.join(tmpDir, 'current-picks.json');

writeCurrentPicks(report, target);

assert.ok(fs.existsSync(target), 'current-picks.json should exist');
assert.ok(!fs.existsSync(`${target}.tmp`), 'tmp file should be renamed away');

const parsed = JSON.parse(fs.readFileSync(target, 'utf-8'));
assert.deepStrictEqual(parsed, built, 'file on disk should parse back to the built object');

// Overwrite (second weekly run) still lands atomically over the old file.
const nextReport: WeeklyReport = { ...report, stockPicks: [breakoutPick], generatedAt: '2026-07-10T12:00:00.000Z' };
writeCurrentPicks(nextReport, target);
const parsed2 = JSON.parse(fs.readFileSync(target, 'utf-8'));
assert.strictEqual(parsed2.generatedAt, '2026-07-10T12:00:00.000Z');
assert.strictEqual(parsed2.picks.length, 1);
assert.ok(!fs.existsSync(`${target}.tmp`));

// ── 3. Legacy file with a retired option_call entry still reads ──
// Exact shape the pre-July-2026 writer produced, including the
// option object. Consumers read this file as plain JSON — parsing
// and iterating it must not throw, and the swing entries must
// still be usable alongside the legacy row.
const legacyFile = {
  generatedAt: '2026-06-29T12:00:00.000Z',
  scanType: 'weekly',
  picks: [
    {
      ticker: 'TSLA',
      type: 'option_call',
      strategy: 'BREAKOUT',
      entryPrice: 435.79,
      target: 470,
      stop: 415,
      option: { strike: 445, expiry: '2026-07-10', midAtPick: 8.35 },
      earningsFlag: false,
    },
    {
      ticker: 'ABC',
      type: 'swing',
      strategy: 'PULLBACK',
      entryPrice: 18.40,
      target: 21.00,
      stop: 17.10,
      option: null,
      earningsFlag: false,
    },
  ],
};
const legacyPath = path.join(tmpDir, 'legacy-current-picks.json');
fs.writeFileSync(legacyPath, JSON.stringify(legacyFile, null, 2));

const legacyParsed = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
assert.strictEqual(legacyParsed.picks.length, 2);
const legacySwings = legacyParsed.picks.filter((p: any) => p.type === 'swing');
assert.strictEqual(legacySwings.length, 1);
assert.strictEqual(legacySwings[0].ticker, 'ABC');
// The legacy option row is still readable data, just no longer produced.
const legacyOption = legacyParsed.picks.find((p: any) => p.type === 'option_call');
assert.ok(legacyOption && legacyOption.option.strike === 445);

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ current-picks.json test passed (build, atomic write, parse, overwrite, legacy read)');
