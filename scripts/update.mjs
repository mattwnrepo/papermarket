// scripts/update.mjs
// Fetches live Polymarket markets and asks Gemini for bot trading decisions.
// Outputs:  docs/data/markets.json   – current market snapshots
//           docs/data/bot_trades.json – bot portfolio state
//

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);          // native fetch (Node 18+)
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

  // Normalise to a clean shape for the frontend
  const markets = raw.map((m) => {
    // 1. Determine outcomes. If m.outcomes is a string, parse it. 
    // If it's missing, default to ["Yes", "No"] for binary markets.
    let outcomeTitles = [];
    try {
      if (Array.isArray(m.outcomes)) {
        outcomeTitles = m.outcomes;
      } else if (typeof m.outcomes === 'string') {
        outcomeTitles = JSON.parse(m.outcomes);
      } else {
        // Fallback for standard binary markets if outcomes are missing
        outcomeTitles = ['Yes', 'No'];
      }
    } catch (e) {
      outcomeTitles = ['Yes', 'No'];
    }

    // 2. Parse prices safely
    const rawPrices = Array.isArray(m.outcomePrices) 
      ? m.outcomePrices 
      : JSON.parse(m.outcomePrices || '["0.5", "0.5"]');

    return {
      id: m.id,
      question: m.question,
      category: m.category || 'General',
      endDate: m.endDate || null,
      outcomes: outcomeTitles.map((title, i) => ({
        id: `${m.id}-${i}`,
        title: title,
        price: parseFloat(rawPrices[i] ?? '0.5'),
      })),
      volume: parseFloat(m.volume || '0'),
      liquidity: parseFloat(m.liquidity || '0'),
      lastUpdated: new Date().toISOString(),
    };
  });

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

  // Build a compact market summary to keep the prompt short
  const marketSummary = markets.map((m) => ({
    id: m.id,
    question: m.question,
    category: m.category,
    yesPrice:
      m.outcomes.find((o) => o.title === 'Yes')?.price ??
      m.outcomes[0]?.price ??
      0.5,
    volume: Math.round(m.volume),
  }));

  const portfolioSummary = {
    cash: existingPortfolio.cash,
    positions: existingPortfolio.positions,
    totalValue: existingPortfolio.totalValue,
  };

  const prompt = `You are a balanced, moderate-risk prediction market trader with $${portfolioSummary.cash.toFixed(2)} USDC cash available.

Your current portfolio:
${JSON.stringify(portfolioSummary, null, 2)}

Available markets (YES price = implied probability):
${JSON.stringify(marketSummary, null, 2)}

Rules:
- You may BUY YES or BUY NO on any market, or HOLD (do nothing).
- Each trade amount must be between $10 and $200 USDC.
- Never spend more than you have in cash.
- Max 3 new trades per update cycle.
- Balanced strategy: mix of high-confidence bets and value plays.
- If you already hold a position, you may SELL it (provide the market id and outcome).

Respond ONLY with a valid JSON object in this exact format (no markdown, no explanation):
{
  "reasoning": "One sentence summary of your strategy this cycle.",
  "trades": [
    {
      "action": "BUY" | "SELL",
      "marketId": "<market id>",
      "outcome": "Yes" | "No",
      "amount": <number in USDC>
    }
  ]
}`;

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 512 },
      }),
    }
  );

  if (!res.ok) {
    console.error('Gemini API error:', res.status, await res.text());
    return existingPortfolio;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  let decision;
  try {
    // Strip possible markdown fences
    const clean = text.replace(/```json|```/g, '').trim();
    decision = JSON.parse(clean);
  } catch (e) {
    console.error('Failed to parse Gemini response:', text);
    return existingPortfolio;
  }

  // Apply the trades to the portfolio
  const portfolio = structuredClone(existingPortfolio);
  portfolio.lastUpdated = new Date().toISOString();
  portfolio.lastReasoning = decision.reasoning ?? '';

  for (const trade of decision.trades ?? []) {
    const market = markets.find((m) => m.id === trade.marketId);
    if (!market) continue;

    const outcomeObj =
      market.outcomes.find(
        (o) => o.title.toLowerCase() === trade.outcome.toLowerCase()
      ) ?? market.outcomes[0];

    if (trade.action === 'BUY') {
      const cost = Math.min(trade.amount, portfolio.cash);
      if (cost < 1) continue;
      const shares = cost / outcomeObj.price;
      portfolio.cash -= cost;

      const existing = portfolio.positions.find(
        (p) => p.marketId === trade.marketId && p.outcome === trade.outcome
      );
      if (existing) {
        // Average in
        const totalCost = existing.avgCost * existing.shares + cost;
        existing.shares += shares;
        existing.avgCost = totalCost / existing.shares;
      } else {
        portfolio.positions.push({
          marketId: trade.marketId,
          question: market.question,
          outcome: trade.outcome,
          shares,
          avgCost: outcomeObj.price,
          costBasis: cost,
        });
      }

      portfolio.tradeLog.push({
        ts: new Date().toISOString(),
        action: 'BUY',
        question: market.question,
        outcome: trade.outcome,
        amount: cost,
        price: outcomeObj.price,
        reasoning: decision.reasoning,
      });
    } else if (trade.action === 'SELL') {
      const idx = portfolio.positions.findIndex(
        (p) => p.marketId === trade.marketId && p.outcome === trade.outcome
      );
      if (idx === -1) continue;
      const pos = portfolio.positions[idx];
      const currentPrice = outcomeObj.price;
      const proceeds = pos.shares * currentPrice;
      portfolio.cash += proceeds;
      portfolio.tradeLog.push({
        ts: new Date().toISOString(),
        action: 'SELL',
        question: market.question,
        outcome: trade.outcome,
        proceeds,
        price: currentPrice,
        reasoning: decision.reasoning,
      });
      portfolio.positions.splice(idx, 1);
    }
  }

  // Recalculate total portfolio value
  portfolio.totalValue =
    portfolio.cash +
    portfolio.positions.reduce((sum, pos) => {
      const market = markets.find((m) => m.id === pos.marketId);
      const outcomeObj = market?.outcomes.find(
        (o) => o.title.toLowerCase() === pos.outcome.toLowerCase()
      );
      return sum + pos.shares * (outcomeObj?.price ?? pos.avgCost);
    }, 0);

  console.log(
    `   ✅ Bot made ${decision.trades?.length ?? 0} trade(s). Portfolio: $${portfolio.totalValue.toFixed(2)}`
  );
  return portfolio;
}

// ─── 3. Load existing bot portfolio ──────────────────────────────────────────

function loadExistingPortfolio() {
  const path = 'docs/data/bot_trades.json';
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      /* fall through to default */
    }
  }
  return {
    cash: 1000,
    totalValue: 1000,
    positions: [],
    tradeLog: [],
    lastUpdated: new Date().toISOString(),
    lastReasoning: '',
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    ensureDir('docs/data');

    const markets = await fetchMarkets();
    writeFileSync(
      'docs/data/markets.json',
      JSON.stringify({ markets, lastUpdated: new Date().toISOString() }, null, 2)
    );
    console.log('   💾 docs/data/markets.json written');

    const existingPortfolio = loadExistingPortfolio();
    const updatedPortfolio = await getBotDecisions(markets, existingPortfolio);
    writeFileSync('docs/data/bot_trades.json', JSON.stringify(updatedPortfolio, null, 2));
    console.log('   💾 docs/data/bot_trades.json written');

    console.log('✅ Update complete');
  } catch (err) {
    console.error('❌ Update failed:', err);
    process.exit(1);
  }
})();
