// ============================================================
// TEST — current-picks.json snapshot
// Builds sample picks (one option call, one swing), writes the
// snapshot through the real atomic writer to a temp path, reads
// it back, and asserts the parsed shape. Run: npm run test:picks
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

const optionPick: StockPick = {
  ticker: 'XYZ',
  name: 'XYZ Corp',
  pickType: 'OPTIONS_CALL',
  currentPrice: 42.15,
  entryZone: { low: 41.5, high: 42.5 },
  targetPrice: 46.50,
  stopLoss: 39.80,
  riskRewardRatio: 1.9,
  timeHorizon: '1-2 weeks',
  confidenceScore: 78,
  catalysts: ['Product launch'],
  risks: ['Sector rotation'],
  summary: 'Sample option pick',
  technicals,
  news: [],
  options: {
    ticker: 'XYZ', expirationDate: '2026-08-21', strikePrice: 45,
    optionType: 'CALL', premium: 1.32, breakeven: 46.32,
    maxGain: 'unlimited', maxLoss: '$132 per contract',
    impliedVolatility: 0.38, delta: 0.35, volume: 500, openInterest: 1200,
    liquidityNote: 'ok', rationale: 'sample',
  },
  sector: 'Technology',
  addedAt: '2026-07-03T12:00:00.000Z',
  strategy: 'PULLBACK',
  earningsGap: { date: '2026-07-10', daysUntil: 7, withinHorizon: true },
};

const swingPick: StockPick = {
  ...optionPick,
  ticker: 'ABC',
  name: 'ABC Inc',
  pickType: 'STOCK_LONG',
  currentPrice: 18.40,
  targetPrice: 21.00,
  stopLoss: 17.10,
  options: undefined,
  strategy: 'BREAKOUT',
  earningsGap: undefined,
};

const report: WeeklyReport = {
  weekOf: 'July 3, 2026',
  optionsPicks: [optionPick],
  stockPicks: [swingPick],
  marketOutlook: 'test',
  keyEventsThisWeek: [],
  generatedAt: '2026-07-03T12:00:00.000Z',
};

// ── 1. Pure builder produces the expected shape ─────────────
const built = buildCurrentPicks(report);
assert.strictEqual(built.generatedAt, report.generatedAt);
assert.strictEqual(built.scanType, 'weekly');
assert.strictEqual(built.picks.length, 2);

const [opt, swing] = built.picks;
assert.deepStrictEqual(opt, {
  ticker: 'XYZ',
  type: 'option_call',
  strategy: 'PULLBACK',
  entryPrice: 42.15,
  target: 46.50,
  stop: 39.80,
  option: { strike: 45, expiry: '2026-08-21', midAtPick: 1.32 },
  earningsFlag: true,
});
assert.deepStrictEqual(swing, {
  ticker: 'ABC',
  type: 'swing',
  strategy: 'BREAKOUT',
  entryPrice: 18.40,
  target: 21.00,
  stop: 17.10,
  option: null,
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
const nextReport: WeeklyReport = { ...report, optionsPicks: [], generatedAt: '2026-07-10T12:00:00.000Z' };
writeCurrentPicks(nextReport, target);
const parsed2 = JSON.parse(fs.readFileSync(target, 'utf-8'));
assert.strictEqual(parsed2.generatedAt, '2026-07-10T12:00:00.000Z');
assert.strictEqual(parsed2.picks.length, 1);
assert.ok(!fs.existsSync(`${target}.tmp`));

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ current-picks.json test passed (build, atomic write, parse, overwrite)');
