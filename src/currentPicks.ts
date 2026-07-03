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

export interface CurrentPickEntry {
  ticker: string;
  type: 'option_call' | 'swing';
  strategy: 'PULLBACK' | 'BREAKOUT' | null;
  entryPrice: number;
  target: number;
  stop: number;
  option: { strike: number; expiry: string; midAtPick: number } | null;
  earningsFlag: boolean;
}

export interface CurrentPicksFile {
  generatedAt: string;
  scanType: 'weekly';
  picks: CurrentPickEntry[];
}

function toEntry(pick: StockPick): CurrentPickEntry {
  const isOption = pick.pickType === 'OPTIONS_CALL';
  return {
    ticker: pick.ticker,
    type: isOption ? 'option_call' : 'swing',
    strategy: pick.strategy ?? null,
    entryPrice: pick.currentPrice,   // same basis the report and tracker use
    target: pick.targetPrice,
    stop: pick.stopLoss,
    option: isOption && pick.options
      ? {
          strike: pick.options.strikePrice,
          expiry: pick.options.expirationDate,
          midAtPick: pick.options.premium,
        }
      : null,
    earningsFlag: pick.earningsGap?.withinHorizon ?? false,
  };
}

// Pure builder — testable without touching the filesystem.
export function buildCurrentPicks(report: WeeklyReport): CurrentPicksFile {
  return {
    generatedAt: report.generatedAt,
    scanType: 'weekly',
    picks: [...report.optionsPicks, ...report.stockPicks].map(toEntry),
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
