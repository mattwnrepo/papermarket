// scripts/update.mjs
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

// ─── 1. Helpers ─────────────────────────────────────────────────────────────

// NO node-fetch here. Node 20 uses the global fetch.
async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ─── 2. Fetch Polymarket markets ─────────────────────────────────────────────

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

// ─── 3. Gemini Decision Engine ───────────────────────────────────────────────

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
    yesPrice: m.outcomes.find((o) => o.title === 'Yes')?.price ?? m.outcomes[0]?.price ?? 0.5,
  }));

  const prompt = `You are a prediction market trader with $${existingPortfolio.cash.toFixed(2)} USDC.
Respond ONLY with JSON: {"reasoning": "...", "trades": [{"action": "BUY"|"SELL", "marketId": "...", "outcome": "Yes"|"No", "amount": 10}]}`;

  try {
    // Using native fetch to call Gemini
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

    if (!res.ok) throw new Error(`Gemini API Error: ${res.status}`);

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const cleanJson = text.replace(/```json|```/g, '').trim();
    const decision = JSON.parse(cleanJson);

    const portfolio = structuredClone(existingPortfolio);
    portfolio.lastUpdated = new Date().toISOString();
    portfolio.lastReasoning = decision.reasoning ?? '';

    // Simplified Trade Logic
    for (const trade of decision.trades ?? []) {
      const market = markets.find((m) => m.id === trade.marketId);
      if (!market) continue;

      const outcomeObj = market.outcomes.find(
        (o) => o.title.toLowerCase() === trade.outcome.toLowerCase()
      ) ?? market.outcomes[0];

      if (trade.action === 'BUY' && portfolio.cash >= trade.amount) {
        portfolio.cash -= trade.amount;
        portfolio.positions.push({
          marketId: trade.marketId,
          question: market.question,
          outcome: trade.outcome,
          shares: trade.amount / outcomeObj.price,
          avgCost: outcomeObj.price
        });
      }
    }

    return portfolio;
  } catch (e) {
    console.error('❌ Bot decision failed:', e.message);
    return existingPortfolio;
  }
}

// ─── 4. Main Execution ──────────────────────────────────────────────────────

(async () => {
  try {
    ensureDir('docs/data');
    const markets = await fetchMarkets();
    writeFileSync('docs/data/markets.json', JSON.stringify({ markets, lastUpdated: new Date().toISOString() }, null, 2));

    const portfolioPath = 'docs/data/bot_trades.json';
    let portfolio = { cash: 1000, totalValue: 1000, positions: [], lastUpdated: new Date().toISOString(), lastReasoning: '' };
    
    if (existsSync(portfolioPath)) {
      portfolio = JSON.parse(readFileSync(portfolioPath, 'utf8'));
    }

    const updatedPortfolio = await getBotDecisions(markets, portfolio);
    writeFileSync(portfolioPath, JSON.stringify(updatedPortfolio, null, 2));

    console.log('✅ Update complete');
  } catch (err) {
    console.error('❌ Critical Failure:', err);
    process.exit(1);
  }
})();
