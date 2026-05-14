# 📈 PaperMarket — Beat the Bot

A paper trading platform built on GitHub Pages. Trade real Polymarket prediction markets with fake $1,000 USDC and compete against a Gemini-powered AI bot.

---

## How It Works

| Component | How it runs |
|---|---|
| **Market data** | GitHub Actions fetches top 20 Polymarket markets every 30 min → `data/markets.json` |
| **Bot trades** | GitHub Actions asks Gemini for trading decisions every 30 min → `data/bot_trades.json` |
| **User trades** | Stored in browser `localStorage`, P&L calculated against live market prices |
| **Cross-device** | Export/import your portfolio as a JSON backup file |

---

## Setup (5 minutes)

### 1. Fork / clone this repo

```bash
git clone https://github.com/YOUR_USERNAME/papermarket.git
cd papermarket
```

### 2. Add the Gemini API key as a GitHub Secret

1. Get a free API key from [Google AI Studio](https://aistudio.google.com/app/apikey)
2. Go to your repo → **Settings → Secrets and variables → Actions**
3. Click **New repository secret**
4. Name: `GEMINI_API_KEY` | Value: your key

### 3. Enable GitHub Pages

1. Go to **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: `main` | Folder: `/docs`
4. Save

### 4. Trigger the first data update

Go to **Actions → Update Market Data & Bot Trades → Run workflow**

After ~30 seconds, `data/markets.json` and `data/bot_trades.json` will be populated and your site will be live.

---

## File Structure

```
papermarket/
├── docs/
│   ├── index.html                # The full UI (served by GitHub Pages)
│   └── data/
│       ├── markets.json          # Live market data (auto-updated)
│       └── bot_trades.json       # Bot portfolio state (auto-updated)
├── scripts/
│   └── update.mjs                # Node.js update script
└── .github/
    └── workflows/
        └── update.yml            # GitHub Actions workflow
```

---

## Notes

- **No backend needed** — everything runs on GitHub Actions + localStorage
- **Bot strategy** — balanced, moderate-risk; Gemini picks up to 3 trades per cycle
- **Market data** — uses Polymarket's public Gamma API (no key required)
- The workflow runs every 30 minutes; you can also trigger it manually via the Actions tab
