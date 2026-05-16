import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';

// ─── helpers ────────────────────────────────────────────────────────────────

async function fetchJSON(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  return res.json();
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function normaliseMarket(m, extra = {}) {
  let outcomeTitles = [];
  try {
    if (Array.isArray(m.outcomes))           outcomeTitles = m.outcomes;
    else if (typeof m.outcomes === 'string') outcomeTitles = JSON.parse(m.outcomes);
    else                                     outcomeTitles = ['Yes', 'No'];
  } catch { outcomeTitles = ['Yes', 'No']; }

  const rawPrices = Array.isArray(m.outcomePrices)
    ? m.outcomePrices
    : JSON.parse(m.outcomePrices || '["0.5","0.5"]');

  return {
    id:       m.id,
    question: m.question,
    category: m.category || 'General',
    endDate:  m.endDate || null,
    outcomes: outcomeTitles.map((title, i) => ({
      id:    `${m.id}-${i}`,
      title,
      price: parseFloat(rawPrices[i] ?? '0.5'),
    })),
    volume:      parseFloat(m.volume    || '0'),
    liquidity:   parseFloat(m.liquidity || '0'),
    lastUpdated: new Date().toISOString(),
    ...extra,   // e.g. { droppedFromTop: true }
  };
}

// ─── 1. Fetch top-20 Polymarket markets ──────────────────────────────────────

async function fetchMarkets() {
  console.log('📡 Fetching Polymarket markets (10-90% range)…');

  const url =
    'https://gamma-api.polymarket.com/markets?' +
    new URLSearchParams({
      active: 'true',
      closed: 'false',
      limit: '100', // Increased to 100 so we have plenty left after filtering
      order: 'volume24hr',
      ascending: 'false',
    });

  const raw = await fetchJSON(url);

  const markets = raw
    .map((m) => {
      // 1. Determine outcomes and parse prices
      let outcomeTitles = [];
      try {
        outcomeTitles = Array.isArray(m.outcomes) ? m.outcomes : JSON.parse(m.outcomes || '["Yes", "No"]');
      } catch (e) {
        outcomeTitles = ['Yes', 'No'];
      }

      let prices = [];
      try {
        prices = Array.isArray(m.outcomePrices) ? m.outcomePrices : JSON.parse(m.outcomePrices || '["0.5", "0.5"]');
      } catch (e) {
        prices = ['0.5', '0.5'];
      }

      // We focus on the "Yes" price (usually index 0) for the filter
      const yesPrice = parseFloat(prices[0] ?? '0.5');

      return {
        id: m.id,
        question: m.question,
        category: m.category || 'General',
        endDate: m.endDate || null,
        yesPrice: yesPrice, // Helper for our filter
        outcomes: outcomeTitles.map((title, i) => ({
          id: `${m.id}-${i}`,
          title: title,
          price: parseFloat(prices[i] ?? '0.5'),
        })),
        volume: parseFloat(m.volume || '0'),
        liquidity: parseFloat(m.liquidity || '0'),
        lastUpdated: new Date().toISOString(),
      };
    })
    // ─── FILTER FOR 10% - 90% RANGE ───
    .filter((m) => m.yesPrice >= 0.1 && m.yesPrice <= 0.9);

  console.log(`   ✅ ${markets.length} unbiased markets fetched (after filtering)`);
  return markets;
}

// ─── 2. Re-fetch held markets that dropped out of top-20 ─────────────────────
// Prevents prices from freezing for markets the bot still holds a position in.
// Three outcomes per market:
//   a) Still active  → fresh price,  droppedFromTop: true
//   b) Resolved      → final price,  droppedFromTop: true, resolved: true
//   c) API error     → last known price, stalePrices: true  (better than missing)

async function refreshDroppedMarkets(topMarkets, existingPortfolio) {
  const listedIds = new Set(topMarkets.map(m => m.id));
  const heldIds   = new Set((existingPortfolio.positions || []).map(p => p.marketId));
  const droppedIds = [...heldIds].filter(id => !listedIds.has(id));

  if (!droppedIds.length) return topMarkets;

  console.log(`📉 ${droppedIds.length} held market(s) dropped from top-20 — re-fetching live prices…`);

  const refreshed = [...topMarkets];

  for (const id of droppedIds) {
    try {
      const m = await fetchJSON(`https://gamma-api.polymarket.com/markets/${id}`);

      if (m.closed || m.archived) {
        console.log(`   ⚑  Market ${id} resolved — keeping final prices`);
        refreshed.push(normaliseMarket(m, { droppedFromTop: true, resolved: true }));
      } else {
        console.log(`   🔄 Refreshed: ${m.question?.slice(0, 60)}…`);
        refreshed.push(normaliseMarket(m, { droppedFromTop: true }));
      }
    } catch (err) {
      // Stale is better than missing — carry forward last known price
      console.warn(`   ⚠️  Could not refresh market ${id}: ${err.message}`);
      const lastKnown = (existingPortfolio.positions || []).find(p => p.marketId === id);
      if (lastKnown) {
        refreshed.push({
          id,
          question:  lastKnown.question,
          category:  'General',
          endDate:   null,
          outcomes: [
            { id: `${id}-0`, title: 'Yes', price: lastKnown.avgCost },
            { id: `${id}-1`, title: 'No',  price: 1 - lastKnown.avgCost },
          ],
          volume:         0,
          liquidity:      0,
          lastUpdated:    null,
          droppedFromTop: true,
          stalePrices:    true,  // frontend can show a warning badge
        });
      }
    }
  }

  return refreshed;
}

// ─── 3. Ask Gemini for bot decisions ─────────────────────────────────────────

async function getBotDecisions(markets, existingPortfolio) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('⚠️  GEMINI_API_KEY not set – skipping bot update');
    return existingPortfolio;
  }

  console.log('🤖 Asking Gemini for trading decisions…');

  // Only offer the bot markets that are actively tradeable (not dropped/resolved)
  const tradeableMarkets = markets.filter(m => !m.droppedFromTop);

  const marketSummary = tradeableMarkets.map(m => ({
    id:       m.id,
    question: m.question,
    category: m.category,
    yesPrice: m.outcomes.find(o => o.title === 'Yes')?.price ?? m.outcomes[0]?.price ?? 0.5,
    volume:   Math.round(m.volume),
  }));

  const portfolioSummary = {
    cash:       existingPortfolio.cash,
    positions:  existingPortfolio.positions,
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

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { 
          temperature: 0.1, // Lower temperature = more "robotic" and safe
          maxOutputTokens: 1024,

        },
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
    const startIdx = text.indexOf('{');
    const endIdx   = text.lastIndexOf('}') + 1;
    decision = JSON.parse(text.substring(startIdx, endIdx));
  } catch (e) {
    console.error('❌ Failed to parse Gemini response. Raw text was:', text);
    return existingPortfolio;
  }

  const portfolio = structuredClone(existingPortfolio);
  portfolio.lastUpdated   = new Date().toISOString();
  portfolio.lastReasoning = decision.reasoning ?? '';

  for (const trade of decision.trades ?? []) {
    // Use full markets array so SELL works even on dropped positions
    const market = markets.find(m => m.id === trade.marketId);
    if (!market) continue;

    const outcomeObj =
      market.outcomes.find(o => o.title.toLowerCase() === trade.outcome.toLowerCase())
      ?? market.outcomes[0];

    if (trade.action === 'BUY') {
      // Never BUY into a market that has dropped out of the top-20
      if (market.droppedFromTop) continue;

      const cost = Math.min(trade.amount, portfolio.cash);
      if (cost < 1) continue;
      const shares = cost / outcomeObj.price;
      portfolio.cash -= cost;

      const existing = portfolio.positions.find(
        p => p.marketId === trade.marketId && p.outcome === trade.outcome
      );
      if (existing) {
        const totalCost  = existing.avgCost * existing.shares + cost;
        existing.shares += shares;
        existing.avgCost = totalCost / existing.shares;
      } else {
        portfolio.positions.push({
          marketId:  trade.marketId,
          question:  market.question,
          outcome:   trade.outcome,
          shares,
          avgCost:   outcomeObj.price,
          costBasis: cost,
        });
      }

      portfolio.tradeLog.push({
        ts:        new Date().toISOString(),
        action:    'BUY',
        marketId:  trade.marketId,
        question:  market.question,
        outcome:   trade.outcome,
        amount:    cost,
        price:     outcomeObj.price,
        reasoning: decision.reasoning,
      });

    } else if (trade.action === 'SELL') {
      const idx = portfolio.positions.findIndex(
        p => p.marketId === trade.marketId && p.outcome === trade.outcome
      );
      if (idx === -1) continue;
      const pos      = portfolio.positions[idx];
      const proceeds = pos.shares * outcomeObj.price;
      portfolio.cash += proceeds;
      portfolio.tradeLog.push({
        ts:        new Date().toISOString(),
        action:    'SELL',
        marketId:  trade.marketId,
        question:  market.question,
        outcome:   trade.outcome,
        proceeds,
        price:     outcomeObj.price,
        reasoning: decision.reasoning,
      });
      portfolio.positions.splice(idx, 1);
    }
  }

  // Recalculate total value across ALL markets including dropped ones
  portfolio.totalValue =
    portfolio.cash +
    portfolio.positions.reduce((sum, pos) => {
      const market     = markets.find(m => m.id === pos.marketId);
      const outcomeObj = market?.outcomes.find(
        o => o.title.toLowerCase() === pos.outcome.toLowerCase()
      );
      return sum + pos.shares * (outcomeObj?.price ?? pos.avgCost);
    }, 0);

  console.log(
    `   ✅ Bot made ${decision.trades?.length ?? 0} trade(s). Portfolio: $${portfolio.totalValue.toFixed(2)}`
  );
  return portfolio;
}

// ─── 4. Load existing bot portfolio ──────────────────────────────────────────

function loadExistingPortfolio() {
  const path = 'docs/data/bot_trades.json';
  if (existsSync(path)) {
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch { /* fall through */ }
  }
  return {
    cash:          1000,
    totalValue:    1000,
    positions:     [],
    tradeLog:      [],
    lastUpdated:   new Date().toISOString(),
    lastReasoning: '',
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

(async () => {
  try {
    ensureDir('docs/data');

    // Load first so refreshDroppedMarkets knows what positions are held
    const existingPortfolio = loadExistingPortfolio();

    // Step 1: fresh top-20
    const topMarkets = await fetchMarkets();

    // Step 2: bot decisions first (so we know final positions before writing markets)
    // Pass topMarkets only for BUY eligibility; refreshDroppedMarkets runs after
    // so markets.json reflects actual open positions (not already-sold ones).
    const allMarketsForBot = await refreshDroppedMarkets(topMarkets, existingPortfolio);
    const updatedPortfolio = await getBotDecisions(allMarketsForBot, existingPortfolio);
    writeFileSync('docs/data/bot_trades.json', JSON.stringify(updatedPortfolio, null, 2));
    console.log('   💾 docs/data/bot_trades.json written');

    // Step 3: re-fetch dropped markets based on FINAL positions (post-sell)
    // This ensures sold positions no longer appear as droppedFromTop in markets.json
    const allMarkets = await refreshDroppedMarkets(topMarkets, updatedPortfolio);
    writeFileSync(
      'docs/data/markets.json',
      JSON.stringify({ markets: allMarkets, lastUpdated: new Date().toISOString() }, null, 2)
    );
    console.log('   💾 docs/data/markets.json written');

    console.log('✅ Update complete');
  } catch (err) {
    console.error('❌ Update failed:', err);
    process.exit(1);
  }
})();
