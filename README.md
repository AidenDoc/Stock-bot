# 📈 Stock Bot — AI-Powered Trading Alerts

Built on the same architecture as your Kalshi Bot. Sends weekly stock picks to Telegram for execution on Robinhood.

> Options picks were removed in July 2026: live tracking showed picks mostly
> drift +1-2%/week with ~10% hitting targets — workable for stock positions,
> but a losing profile against theta on weekly OTM calls. Historical
> OPTIONS_CALL grades remain in the scorecard record.

## Features

- **Weekly Stock Picks** (3-4 picks, every Monday 10:15am ET; skips market holidays)
  - Entry/exit levels, stop loss, R/R ratio
  - Technical analysis + news sentiment
- **Daily Position Updates** (Weekdays 9am ET)
  - Current P&L, hold/exit recommendations
  - Target hit & stop loss instant alerts

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
# Test weekly picks RIGHT NOW
node dist/bot.js --weekly

# Test daily check
node dist/bot.js --daily
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
Edit `WEEKLY_CRON` and `DAILY_CRON` in `.env`

**Adjust aggressiveness:**
In `src/scanner.ts`: lower `score >= 30` threshold for more picks
In `src/analyst.ts`: lower `confidenceScore < 60` for more aggressive picks

**Add your own tickers:**
Modify the `getCandidateTickers()` array to focus on stocks you follow
