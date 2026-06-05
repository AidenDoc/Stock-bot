import { getQuote } from './marketData';

// Fill these in from last week's Telegram messages
const lastWeekPicks = [
  { ticker: 'TSLA', type: 'option', entry: 435.79, target: 470, stop: 415 },
  { ticker: 'BEAM', type: 'option', entry: 32.93, target: 37, stop: 30.80 },
  { ticker: 'OUST', type: 'option', entry: 46.05, target: 54, stop: 42.50 },
  // add your stock picks too: { ticker: 'NVDA', type: 'stock', entry: ..., target: ..., stop: ... },
];

(async () => {
  console.log('\n=== LAST WEEK SCORECARD ===\n');
  let wins = 0, losses = 0;
  for (const p of lastWeekPicks) {
    const q = await getQuote(p.ticker);
    if (!q) { console.log(`${p.ticker}: couldn't fetch price`); continue; }
    const now = q.price;
    const stockMove = ((now - p.entry) / p.entry) * 100;
    let outcome: string;
    if (now >= p.target) { outcome = 'WIN (hit target)'; wins++; }
    else if (now <= p.stop) { outcome = 'LOSS (hit stop)'; losses++; }
    else { outcome = stockMove >= 0 ? 'WIN (up, no target)' : 'LOSS (down)'; stockMove >= 0 ? wins++ : losses++; }
    console.log(`${p.ticker} (${p.type}): entry $${p.entry} → now $${now.toFixed(2)} | ${stockMove >= 0 ? '+' : ''}${stockMove.toFixed(1)}% | ${outcome}`);
  }
  console.log(`\nRecord: ${wins}W / ${losses}L`);
})();