// ============================================================
// CURRENT PICKS SNAPSHOT — data/current-picks.json
// Written once per weekly scan, AFTER picks are finalized.
// Contains ONLY the new week's picks, built from the same
// StockPick values sent in the Telegram weekly reports.
// ============================================================

import fs from 'fs';
import path from 'path';
import { StockPick, WeeklyReport } from './types';

const CURRENT_PICKS_FILE = path.join(process.cwd(), 'data', 'current-picks.json');

// The written shape is stock-only as of July 2026. Old files on disk may
// still contain type 'option_call' entries with an `option` object —
// readers must tolerate those (they're plain JSON; never validate them away).
export interface CurrentPickEntry {
  ticker: string;
  type: 'swing';
  strategy: 'PULLBACK' | 'BREAKOUT' | null;
  entryPrice: number;
  target: number;
  stop: number;
  earningsFlag: boolean;
  // V2 trade-plan context (absent on files written before the rolling regime):
  horizonDays?: number;
  expiryDate?: string;
}

export interface CurrentPicksFile {
  generatedAt: string;
  // 'weekly' survives on old files; every new write is 'rolling'.
  scanType: 'weekly' | 'rolling';
  picks: CurrentPickEntry[];
}

function toEntry(pick: StockPick): CurrentPickEntry {
  return {
    ticker: pick.ticker,
    type: 'swing',
    strategy: pick.strategy ?? null,
    entryPrice: pick.currentPrice,   // same basis the report and tracker use
    target: pick.targetPrice,
    stop: pick.stopLoss,
    earningsFlag: pick.earningsGap?.withinHorizon ?? false,
    // Only present on V2 picks — omitted (not undefined) so the written
    // JSON round-trips byte-identically to the built object.
    ...(pick.horizonDays != null ? { horizonDays: pick.horizonDays } : {}),
    ...(pick.expiryDate ? { expiryDate: pick.expiryDate } : {}),
  };
}

// Pure builder — testable without touching the filesystem.
export function buildCurrentPicks(report: WeeklyReport): CurrentPicksFile {
  return {
    generatedAt: report.generatedAt,
    scanType: 'rolling',
    picks: report.stockPicks.map(toEntry),
  };
}

// Atomic write: dump to <file>.tmp, then rename over the target so
// readers (dashboard, VPS consumers) never see a half-written file.
export function writeCurrentPicks(report: WeeklyReport, filePath: string = CURRENT_PICKS_FILE): void {
  const payload = buildCurrentPicks(report);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tmpPath, filePath);
  console.log(`[CurrentPicks] Wrote ${payload.picks.length} picks to ${filePath}`);
}
