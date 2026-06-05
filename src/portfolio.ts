// ============================================================
// PORTFOLIO TRACKER — tracks open positions, checks targets
// Persists to a JSON file (same pattern as Kalshi bot)
// ============================================================

import fs from 'fs';
import path from 'path';
import { PortfolioPosition, StockPick, DailyUpdate } from './types';
import { getQuote } from './marketData';
import { getStockNews } from './news';
import { generatePositionUpdate } from './analyst';
import {
  sendTargetHitAlert,
  sendStopLossAlert,
  sendDailyUpdate
} from './telegram';

const DB_FILE = path.join(process.cwd(), 'data', 'portfolio.json');

// ── Load / Save ────────────────────────────────────────────
function loadPortfolio(): PortfolioPosition[] {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function savePortfolio(positions: PortfolioPosition[]): void {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(positions, null, 2));
}

// ── Add position from a pick ───────────────────────────────
export function addPosition(pick: StockPick): void {
  const positions = loadPortfolio();

  // Don't add duplicates
  if (positions.find(p => p.ticker === pick.ticker && p.status === 'ACTIVE')) {
    console.log(`[Portfolio] ${pick.ticker} already in portfolio`);
    return;
  }

  const position: PortfolioPosition = {
    ticker: pick.ticker,
    pickType: pick.pickType,
    entryPrice: pick.currentPrice,  // Use current price as entry (you confirm in Robinhood)
    currentPrice: pick.currentPrice,
    targetPrice: pick.targetPrice,
    stopLoss: pick.stopLoss,
    addedDate: new Date().toISOString(),
    status: 'WATCHING',  // WATCHING = not entered yet, ACTIVE = you're in the trade
    pnlPercent: 0,
    notes: pick.summary,
  };

  positions.push(position);
  savePortfolio(positions);
  console.log(`[Portfolio] Added ${pick.ticker} to watchlist`);
}

// ── Mark as entered (call this when you actually buy) ──────
export function enterPosition(ticker: string, entryPrice: number): void {
  const positions = loadPortfolio();
  const pos = positions.find(p => p.ticker === ticker && p.status === 'WATCHING');
  if (!pos) {
    console.log(`[Portfolio] ${ticker} not found in watchlist`);
    return;
  }

  pos.status = 'ACTIVE';
  pos.entryPrice = entryPrice;
  savePortfolio(positions);
  console.log(`[Portfolio] ${ticker} marked as ACTIVE at $${entryPrice}`);
}

// ── Close a position ──────────────────────────────────────
export function closePosition(ticker: string, exitPrice?: number): void {
  const positions = loadPortfolio();
  const pos = positions.find(p => p.ticker === ticker && p.status !== 'CLOSED');
  if (!pos) return;

  if (exitPrice) {
    pos.pnlPercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
  }
  pos.status = 'CLOSED';
  savePortfolio(positions);
  console.log(`[Portfolio] ${ticker} closed. P&L: ${pos.pnlPercent.toFixed(1)}%`);
}

// ── Daily check — update prices, fire alerts ──────────────
export async function runDailyCheck(): Promise<void> {
  console.log('[Portfolio] Running daily position check...');
  const positions = loadPortfolio().filter(p => p.status !== 'CLOSED');

  if (positions.length === 0) {
    console.log('[Portfolio] No active positions to check');
    await sendDailyUpdate([]);
    return;
  }

  const updates: DailyUpdate[] = [];

  for (const pos of positions) {
    const quote = await getQuote(pos.ticker);
    if (!quote) continue;

    const currentPrice = quote.price;
    pos.currentPrice = currentPrice;
    pos.pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Check target hit (for ACTIVE positions)
    if (pos.status === 'ACTIVE' && currentPrice >= pos.targetPrice) {
      await sendTargetHitAlert(pos.ticker, currentPrice, pos.pnlPercent);
    }

    // Check stop loss warning (within 2% of stop)
    if (pos.status === 'ACTIVE' && currentPrice <= pos.stopLoss * 1.02) {
      await sendStopLossAlert(pos.ticker, currentPrice, pos.stopLoss);
    }

    // Generate AI update for active positions
    let aiUpdate = { action: 'HOLD', update: 'Hold per original plan.' };
    if (pos.status === 'ACTIVE') {
      const news = await getStockNews(pos.ticker, pos.ticker);
      aiUpdate = await generatePositionUpdate(
        pos.ticker,
        pos.pickType,
        pos.entryPrice,
        currentPrice,
        pos.targetPrice,
        pos.stopLoss,
        news
      );
    }

    updates.push({
      date: new Date().toISOString(),
      ticker: pos.ticker,
      currentPrice,
      entryPrice: pos.entryPrice,
      targetPrice: pos.targetPrice,
      stopLoss: pos.stopLoss,
      pnlPercent: pos.pnlPercent,
      status: pos.status === 'ACTIVE' ? 'ENTERED' : 'WATCHING',
      update: aiUpdate.update,
      action: aiUpdate.action as any,
    });
  }

  savePortfolio(positions);
  await sendDailyUpdate(updates);
  console.log(`[Portfolio] Daily check complete. ${updates.length} positions updated.`);
}

// ── Get portfolio summary ─────────────────────────────────
export function getPortfolioSummary(): { total: number; active: number; watching: number; avgPnl: number } {
  const positions = loadPortfolio();
  const active = positions.filter(p => p.status === 'ACTIVE');
  const watching = positions.filter(p => p.status === 'WATCHING');
  const avgPnl = active.length
    ? active.reduce((sum, p) => sum + p.pnlPercent, 0) / active.length
    : 0;

  return {
    total: positions.length,
    active: active.length,
    watching: watching.length,
    avgPnl,
  };
}
