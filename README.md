# 📈 Stock Bot — AI-Powered Trading Alerts

Built on the same architecture as your Kalshi Bot. Maintains rolling trade-plan positions and sends entries/exits to Telegram for execution on Robinhood.

> Options picks were removed in July 2026: live tracking showed picks mostly
> drift +1-2%/week with ~10% hitting targets — workable for stock positions,
> but a losing profile against theta on weekly OTM calls. Historical
> OPTIONS_CALL grades remain in the scorecard record.

> **August 2026 — V2 trade-plan regime.** The weekly batch-and-score model was
> replaced with 4–5 rolling position slots. Every pick is a full trade plan
> fixed at entry (absolute TP, SL, R/R, and a hard horizon in trading days);
> positions exit on TP, SL, or time expiry — whichever comes first — evaluated
> on completed daily bars. All records carry an `exitRegime` tag
> (`V1_WEEKLY` legacy vs `V2_TRADE_PLAN`) and the two never mix in stats or
> memory retrieval. Run `npm run migrate:regime` once after deploying to tag
> legacy records, and `npm run rescore` to replay history at 5/10/15/20-day
> horizons.

## Features

- **Rolling Trade-Plan Positions** (up to `MAX_SLOTS`, default 5)
  - Scan runs weekdays 10:15am ET (skips market holidays) but only when a
    slot is free; it picks exactly enough candidates to fill open slots and
    never lowers the 0.65 ensemble consensus bar to fill one
  - Per-strategy plan defaults (env-overridable, see `src/tradePlan.ts`):
    BREAKOUT 7 trading days, TP +8% / SL −4%; PULLBACK 15 trading days,
    TP +10% / SL −5% (both R/R 2.0)
- **Daily Exit Monitor** (Weekdays 9am ET)
  - Evaluates completed daily bars only: same-bar TP+SL counts as a stop
    (conservative); horizon expiry exits at that day's close
  - Exit alerts (🎯 target / 🛑 stop / ⏱ time) with return and SPY excess
    over the actual holding window; current P&L updates and stop warnings
- **Simulated Paper Account** — mirrors what real money would do on the bot's picks
  - Starts at `PAPER_STARTING_BALANCE` (env var, default **$200**); state lives in
    `data/paper-account.json` (gitignored with the rest of `data/`)
  - Equal-notional fractional-share sizing per weekly pick ($5 minimum notional;
    thin cash funds the highest-confidence picks first) — the sizing logic in
    `src/positionSizing.ts` is pure and is THE module real execution will reuse
  - Robinhood cash-account realism: sale proceeds settle **T+1** before they can
    be redeployed; buys spend settled cash only
  - Sells when the tracker calls target/stop (at the target/stop price) or when
    weekly grading force-closes a pick (at the graded final price)
  - Dashboard section (equity curve vs a same-period SPY benchmark), `/paper`
    Telegram command, and `/paperreset` (two-step confirm; archives the old
    file to `data/paper-account.archive-<date>.json`)
  - Paper only — no brokerage connection; if the account file is missing or
    corrupt the bot logs it and continues (a scan never fails because of the
    simulator)

---

## Setup

### Step 1: Create a New Telegram Bot

1. Open Telegram → search `@BotFather`
2. Send `/newbot`
3. Name it something like `StockTrader_Bot`
4. Copy the **Bot Token**
5. Send a message to your new bot
6. Get your Chat ID: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`

> ⚠️ Use a **different bot** from your Kalshi `@KalshiTrader_Bot`

### Step 2: Get API Keys

| Service | Free Tier | Link |
|---|---|---|
| Alpha Vantage | 25 req/day | https://www.alphavantage.co/support/#api-key |
| Financial Modeling Prep | 250 req/day | https://financialmodelingprep.com/developer/docs/ |
| NewsAPI | 100 req/day | https://newsapi.org/register |
| Anthropic | Pay per use | Already have this |

### Step 3: Configure .env

```bash
cp .env.example .env
nano .env
```

Fill in all values.

### Step 4: Deploy to VPS

```bash
# On your laptop — push to GitHub
git add .
git commit -m "add stock bot"
git push

# On VPS (ssh root@159.223.189.172)
cd ~
git clone https://github.com/AidenDoc/stock-bot  # or wherever you put it
cd stock-bot
npm install
npm run build
mkdir -p logs data

# Copy your .env
nano .env  # paste in all values

# Start with PM2 (same as Kalshi bot)
pm2 start ecosystem.config.js
pm2 save
pm2 list
```

### Step 5: Test manually

```bash
# Run the rolling scan RIGHT NOW (fills open slots; --weekly is an alias)
node dist/bot.js --scan

# Dry-run the scan without writing state (cap universe for a quick smoke test)
node dist/bot.js --scan --dry-run --limit=15

# Daily check + exit monitor
node dist/bot.js --daily

# Exit monitor only, no writes
node dist/bot.js --monitor --dry-run
```

---

## Pipeline Architecture

```
Scanner (scores 30+ tickers)
    ↓
Analyst (Claude AI analyzes top candidates)
    ↓
Notifier (formats + sends to Telegram)
    ↓
Portfolio Tracker (logs positions to data/portfolio.json)
    ↓
Daily Checker (monitors P&L, fires alerts)
```

---

## Robinhood Execution

When you get a Telegram alert:

1. Open Robinhood → search the ticker  
2. Tap **Buy**
3. Set **Limit** order at the entry zone high shown
4. Set stop loss as a separate **Sell Stop** order

---

## PM2 Commands

```bash
pm2 list                    # check status
pm2 logs stock-bot          # view live logs
pm2 restart stock-bot       # restart after code changes
pm2 stop stock-bot          # pause the bot
```

---

## File Structure

```
stock-bot/
├── src/
│   ├── bot.ts          # Main entry + cron scheduler
│   ├── scanner.ts      # Pre-screens 30+ tickers
│   ├── analyst.ts      # Claude AI analysis
│   ├── marketData.ts   # Quotes, technicals (Alpha Vantage + FMP)
│   ├── news.ts         # NewsAPI fetcher + sentiment
│   ├── portfolio.ts    # Position tracker
│   ├── telegram.ts     # Formatted Telegram alerts
│   └── types.ts        # TypeScript interfaces
├── data/
│   └── portfolio.json  # Persisted positions (auto-created)
├── logs/               # PM2 log files
├── .env                # Your secrets (never commit!)
├── ecosystem.config.js # PM2 config
└── README.md
```

---

## Customization

**Change which stocks are scanned:**
Edit `getCandidateTickers()` in `src/marketData.ts`

**Change pick frequency/timing:**
Edit `SCAN_CRON` (default `15 10 * * 1-5`) and `DAILY_CRON` in `.env`.
(`WEEKLY_CRON` is a dead key from the weekly regime — it's ignored.)

**Trade-plan knobs (all env, defaults in `src/tradePlan.ts`):**
`MAX_SLOTS`, `BREAKOUT_HORIZON_DAYS`, `BREAKOUT_TP_PCT`, `BREAKOUT_SL_PCT`,
`PULLBACK_HORIZON_DAYS`, `PULLBACK_TP_PCT`, `PULLBACK_SL_PCT`

**Adjust aggressiveness:**
In `src/scanner.ts`: lower `score >= 30` threshold for more picks
In `src/analyst.ts`: lower `confidenceScore < 60` for more aggressive picks

**Add your own tickers:**
Modify the `getCandidateTickers()` array to focus on stocks you follow
