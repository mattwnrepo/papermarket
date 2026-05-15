// scripts/update.mjs
// Fetches live Polymarket markets and asks Gemini for bot trading decisions.
// Outputs:  data/markets.json   – current market snapshots
//           data/bot_trades.json – bot portfolio state

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  // REMOVED: import 'node-fetch' - Node 22 has fetch built-in
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

// ─── 1. Fetch Polymarket markets ─────────────────────────────────────────────

async function fetchMarkets() {
  console.log('📡 Fetching Polymarket markets…');

  const url =
    'https://gamma-api.polymarket.com/markets?' +
    new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: '20',
      order: 'volume24hr',
      ascending: 'false',
    });

  const raw = await fetchJSON(url);

  const markets = raw.map((m) => ({
    id: m.id,
    question: m.question,
    category: m.category || 'General',
    endDate: m.endDate || null,
    outcomes: (m.outcomes || []).map((o, i) => ({
      id: `${m.id}-${i}`,
      title: o,
      price: parseFloat((m.outcomePrices || [])[i] ?? '0.5'),
    })),
    volume: parseFloat(m.volume || '0'),
    liquidity: parseFloat(m.liquidity || '0'),
    lastUpdated: new Date().toISOString(),
  }));

  console.log(`   ✅ ${markets.length} markets fetched`);
  return markets;
}

// ─── 2. Ask Gemini for bot decisions ─────────────────────────────────────────

async function getBotDecisions(markets, existingPortfolio) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  GEMINI_API_KEY not set – skipping bot update');
    return existingPortfolio;
  }

  console.log('🤖 Asking Gemini for trading decisions…');

  const marketSummary = markets.map((m) => ({
    id: m.id,
    question: m.question,
    category: m.category,
    yesPrice: m.outcomes.find((o) => o.title === 'Yes')?.price ??
               m.outcomes[0]?.price ?? 0.5,
    volume: Math.round(m.volume),
  }));

  const portfolioSummary = {
    cash: existingPortfolio.cash,
    positions: existingPortfolio.positions,
    totalValue: existingPortfolio.totalValue,
  };

  const prompt = `You are a balanced, moderate-risk prediction market trader with $${portfolioSummary.cash.toFixed(2)} USDC cash available.
Respond ONLY with a valid JSON object:
{
  "reasoning": "Strategy summary.",
  "trades": [{ "action": "BUY"|"SELL", "marketId": "id", "outcome": "Yes"|"No", "amount": 10 }]
}`;

  // REMOVED: import 'node-fetch' here as well
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
      }),
    }
  );

  if (!res.ok) {
    console.error('Gemini API error:', res.status);
    return existingPortfolio;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  let decision;
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    decision = JSON.parse(clean);
  } catch (e) {
    console.error('Failed to parse Gemini response:', text);
    return existingPortfolio;
  }

  const portfolio = structuredClone(existingPortfolio);
  portfolio.lastUpdated = new Date().toISOString();
  portfolio.lastReasoning = decision.reasoning ?? '';

  for (const trade of decision.trades ?? []) {
    const market = markets.find((m) => m.id === trade.marketId);
    if (!market) continue;

    const outcomeObj = market.outcomes.find(
        (o) => o.title.toLowerCase() === trade.outcome.toLowerCase()
      ) ?? market.outcomes[0];

    if (trade.action === 'BUY') {
      const cost = Math.min(trade.amount, portfolio.cash);
      if (cost < 1) continue;
      const shares = cost / outcomeObj.price;
      portfolio.cash -= cost;

      const existing = portfolio.positions.find(p => p.marketId === trade.marketId && p.outcome === trade.outcome);
      if (existing) {
        const totalCost = existing.avgCost * existing.shares + cost;
        existing.shares += shares;
        existing.avgCost = totalCost / existing.shares;
      } else {
        portfolio.positions.push({
          marketId: trade.marketId,
          question: market.question,
          outcome: trade.outcome,
          shares: shares,
          avgCost: outcomeObj.price,
          costBasis: cost,
        });
      }
    } else if (trade.action === 'SELL') {
      const idx = portfolio.positions.findIndex(p => p.marketId === trade.marketId && p.outcome === trade.outcome);
      if (idx === -1) continue;
      portfolio.cash += portfolio.positions[idx].shares * outcomeObj.price;
      portfolio.positions.splice(idx, 1);
    }
  }

  portfolio.totalValue = portfolio.cash + portfolio.positions.reduce((sum, pos) => {
      const m = markets.find((m) => m.id === pos.marketId);
      const price = m?.outcomes.find((o) => o.title.toLowerCase() === pos.outcome.toLowerCase())?.price ?? pos.avgCost;
      return sum + pos.shares * price;
    }, 0);

  return portfolio;
}

// ─── 3. Load existing bot portfolio ──────────────────────────────────────────

function loadExistingPortfolio() {
  const path = 'docs/data/bot_trades.json';
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch { }
  }
  return { cash: 1000, totalValue: 1000, positions: [], tradeLog: [], lastUpdated: new Date().toISOString(), lastReasoning: '' };
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    ensureDir('docs/data');
    const markets = await fetchMarkets();
    writeFileSync('docs/data/markets.json', JSON.stringify({ markets, lastUpdated: new Date().toISOString() }, null, 2));
    
    const existingPortfolio = loadExistingPortfolio();
    const updatedPortfolio = await getBotDecisions(markets, existingPortfolio);
    writeFileSync('docs/data/bot_trades.json', JSON.stringify(updatedPortfolio, null, 2));

    console.log('✅ Update complete');
  } catch (err) {
    console.error('❌ Update failed:', err);
    process.exit(1);
  }
})();
