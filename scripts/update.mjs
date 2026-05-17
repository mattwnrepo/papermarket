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

  console.log('🤖 Asking Gemini for decisions…');

  const tradeableMarkets = markets.filter(m => !m.droppedFromTop);
  const marketById = new Map(markets.map(m => [m.id, m]));

  const marketSummary = tradeableMarkets.map(m => ({
    id:       m.id,
    question: m.question,
    category: m.category,
    yesPrice: m.outcomes.find(o => o.title === 'Yes')?.price ?? m.outcomes[0]?.price ?? 0.5,
    volume:   Math.round(m.volume),
  }));

  const heldDroppedPositions = existingPortfolio.positions
    .filter(p => {
      const m = marketById.get(p.marketId);
      return !m || m.droppedFromTop;
    })
    .map(p => {
      const m          = marketById.get(p.marketId);
      const outcomeObj = m?.outcomes.find(o => o.title.toLowerCase() === p.outcome.toLowerCase());
      // If market is gone entirely, fall back to avgCost but flag it clearly
      const currentPrice = outcomeObj?.price ?? null;
      const unrealisedPnl = currentPrice !== null
        ? ((currentPrice - p.avgCost) * p.shares).toFixed(2)
        : 'unknown (market no longer available — recommend SELL to reclaim cash)';
      return {
        marketId:     p.marketId,
        question:     p.question,
        outcome:      p.outcome,
        currentPrice: currentPrice ?? 'unavailable',
        boughtAt:     p.avgCost,
        unrealisedPnl,
        resolved:     m?.resolved ?? false,
        action:       'SELL_ONLY',
      };
    });

  const portfolioSummary = {
    cash:       existingPortfolio.cash,
    positions:  existingPortfolio.positions.map(p => ({
      marketId:  p.marketId,
      question:  p.question,
      outcome:   p.outcome,
      shares:    p.shares,
      avgCost:   p.avgCost,
      costBasis: p.costBasis,
    })),
    totalValue: existingPortfolio.totalValue,
  };

  const droppedSection = heldDroppedPositions.length > 0
    ? `IMPORTANT — Positions you must consider selling (dropped/resolved markets):
These no longer appear in the active market list. You CANNOT buy more of these.
You SHOULD sell them to reclaim cash unless you expect a highly favourable resolution.
${JSON.stringify(heldDroppedPositions, null, 2)}

`
    : '';

  const prompt = `You are a mathematical arbitrageur and quantitative risk manager with $${portfolioSummary.cash.toFixed(2)} USDC cash available.
Your goal is capital preservation and harvesting safe, mathematically sound yield. Every contract resolves strictly to $1.00 (Win) or $0.00 (Loss).

Your current portfolio:
${JSON.stringify(portfolioSummary, null, 2)}

Active markets you can BUY or SELL (YES price = implied probability):
${JSON.stringify(marketSummary, null, 2)}

${droppedSection}Strict Risk Management Rules:
1. CAPITAL PRESERVATION FIRST: You do not need to trade every cycle. If active markets are perfectly efficient and present no statistical edge, your optimal move is to HOLD and do absolutely nothing. Sitting on cash is a winning strategy.
2. EVALUATE PROBABILITIES MATHEMATICALLY: You may buy highly priced favorites (above 0.70) or cheap underdogs (below 0.30) only if your internal calculations prove the contract is significantly mispriced by the crowd. Weigh the risk-to-reward ratio stringently before deploying cash.
3. VALUE ARBITRAGE: Look for heavily traded markets where public sentiment is split or overreacting, leaving an exploitable premium between the contract price and real-world probability.
4. HEDGING: If you hold a losing position and the market has flipped completely against you, you may SELL it at a loss to stop the bleeding, or BUY the opposing outcome to lock in an arbitrage hedge.
5. You may BUY YES or BUY NO on active markets, or HOLD (do nothing).
6. Max 2 new BUY trades per cycle. Each BUY must be between $20 and $100 USDC.

Respond ONLY with a valid JSON object in this exact format (no markdown, no prose outside the JSON structure):
{
  "reasoning": "A brief one-sentence mathematical summary of your actions or decision to hold cash.",
  "trades": [
    {
      "action": "BUY" | "SELL",
      "marketId": "<market id>",
      "outcome": "Yes" | "No",
      "amount": 0
    }
  ]
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature:    0.4,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 2048 },
        },
      }),
    }
  );

  function recalcValue(portfolio) {
    portfolio.totalValue =
      portfolio.cash +
      portfolio.positions.reduce((sum, pos) => {
        const mkt = markets.find(m => m.id === pos.marketId);
        const o   = mkt?.outcomes.find(o => o.title.toLowerCase() === pos.outcome.toLowerCase());
        return sum + pos.shares * (o?.price ?? pos.avgCost);
      }, 0);
    portfolio.lastUpdated = new Date().toISOString();
    return portfolio;
  }

  if (!res.ok) {
    console.error('Gemini API error:', res.status, await res.text());
    return recalcValue(structuredClone(existingPortfolio));
  }

  const data = await res.json();
  const finishReason = data?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== 'STOP') {
    console.warn(`⚠️  Gemini finishReason: ${finishReason} — response may be incomplete`);
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

  let decision;
  try {
    const startIdx = text.indexOf('{');
    const endIdx   = text.lastIndexOf('}') + 1;
    decision = JSON.parse(text.substring(startIdx, endIdx));
  } catch (e) {
    console.error('❌ Failed to parse Gemini response. Raw text was:', text);
    return recalcValue(structuredClone(existingPortfolio));
  }

  const portfolio        = structuredClone(existingPortfolio);
  portfolio.lastUpdated  = new Date().toISOString();
  portfolio.lastReasoning = decision.reasoning ?? '';

  for (const trade of decision.trades ?? []) {
    const market = markets.find(m => m.id === trade.marketId);
    if (!market) continue;

    const outcomeObj =
      market.outcomes.find(o => o.title.toLowerCase() === trade.outcome.toLowerCase())
      ?? market.outcomes[0];

    if (trade.action === 'BUY') {
      if (market.droppedFromTop) continue;
      const cost = Math.min(trade.amount, portfolio.cash);
      if (cost < 1) continue;
      const shares = cost / outcomeObj.price;
      portfolio.cash -= cost;
      const existing = portfolio.positions.find(
        p => p.marketId === trade.marketId && p.outcome === trade.outcome
      );
      if (existing) {
        const totalCost   = existing.avgCost * existing.shares + cost;
        existing.shares  += shares;
        existing.avgCost  = totalCost / existing.shares;
        existing.costBasis += cost;
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

  recalcValue(portfolio);
  console.log(
    `   ✅ Bot made ${decision.trades?.length ?? 0} trade(s). Portfolio: $${portfolio.totalValue.toFixed(2)}`
  );
  return portfolio;
}

// ─── 4. Load existing bot portfolio ──────────────────────────────────────────

function loadExistingPortfolio() {
  const path = 'docs/data/bot_trades.json';
  let portfolio = {
    cash: 1000, totalValue: 1000, positions: [],
    tradeLog: [], lastUpdated: new Date().toISOString(), lastReasoning: '',
  };

  if (existsSync(path)) {
    try { portfolio = JSON.parse(readFileSync(path, 'utf8')); }
    catch { /* fall through to default */ }
  }

  // ── Repair 1: backfill marketId on positions ──────────────────────────────
  // Positions always have marketId (written correctly from the start).
  // Build a question→marketId map from positions for use below.
  const questionToId = new Map(portfolio.positions.map(p => [p.question, p.marketId]));

  // ── Repair 2: backfill marketId on tradeLog entries that are missing it ───
  // Early BUY entries (before the marketId fix) have question but no marketId.
  // Match by question against positions first, then against later log entries.
  let repaired = 0;
  for (const t of portfolio.tradeLog) {
    if (t.marketId) {
      // Already has it — keep the question→id mapping up to date
      if (t.question) questionToId.set(t.question, t.marketId);
      continue;
    }
    const id = questionToId.get(t.question);
    if (id) {
      t.marketId = id;
      repaired++;
    }
  }
  if (repaired > 0) console.log(`🔧 Backfilled marketId on ${repaired} tradeLog entries`);

  // ── Repair 3: repair positions whose marketId is still missing ────────────
  for (const pos of portfolio.positions) {
    if (pos.marketId) continue;
    const match = [...portfolio.tradeLog]
      .reverse()
      .find(t => t.action === 'BUY' && t.question === pos.question && t.marketId);
    if (match) {
      console.log(`🔧 Repaired position marketId: ${pos.question?.slice(0, 60)}`);
      pos.marketId = match.marketId;
    } else {
      console.warn(`⚠️  Could not repair marketId for position: ${pos.question?.slice(0, 60)}`);
    }
  }

  return portfolio;
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
