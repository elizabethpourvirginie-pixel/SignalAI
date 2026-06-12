const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const SYMBOL_MAP = {
  "AAPL":"AAPL","NVDA":"NVDA","MSFT":"MSFT","TSLA":"TSLA","AMZN":"AMZN","META":"META","GOOGL":"GOOGL","AMD":"AMD",
  "EUR/USD":"EURUSD=X","GBP/USD":"GBPUSD=X","USD/JPY":"JPY=X","AUD/USD":"AUDUSD=X","USD/CAD":"CAD=X","EUR/GBP":"EURGBP=X",
  "BTC/USD":"BTC-USD","ETH/USD":"ETH-USD","SOL/USD":"SOL-USD","BNB/USD":"BNB-USD","XRP/USD":"XRP-USD","ADA/USD":"ADA-USD",
  "GOLD":"GC=F","SILVER":"SI=F","OIL (WTI)":"CL=F","BRENT":"BZ=F","NATURAL GAS":"NG=F","COPPER":"HG=F",
};

const cache = {};
const CACHE_TTL = 60 * 1000;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

async function fetchChart(ticker, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo Finance error: ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No data returned");
  return result;
}

async function getQuote(asset) {
  const now = Date.now();
  if (cache[asset] && (now - cache[asset].ts) < CACHE_TTL) return cache[asset].data;

  const ticker = SYMBOL_MAP[asset];
  if (!ticker) throw new Error(`Unknown asset: ${asset}`);

  const result = await fetchChart(ticker, "5d", "1d");
  const meta = result.meta;

  const price = meta.regularMarketPrice;
  const prev  = meta.previousClose || meta.chartPreviousClose || price;
  const open  = meta.regularMarketOpen ?? prev;
  const high  = meta.regularMarketDayHigh ?? Math.max(price, prev);
  const low   = meta.regularMarketDayLow ?? Math.min(price, prev);
  const change = price - prev;
  const changePct = prev ? ((change / prev) * 100).toFixed(2) : "0.00";

  const data = {
    asset, ticker, price, open, high, low, prev,
    change: change.toFixed(4), changePct,
    currency: meta.currency || "USD",
    marketState: meta.marketState || "REGULAR",
    timestamp: new Date().toISOString(),
  };
  cache[asset] = { ts: now, data };
  return data;
}

async function getHistory(asset) {
  const ticker = SYMBOL_MAP[asset];
  if (!ticker) throw new Error(`Unknown asset: ${asset}`);

  const result = await fetchChart(ticker, "1d", "1m");
  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const opens  = result.indicators?.quote?.[0]?.open || [];
  const highs  = result.indicators?.quote?.[0]?.high || [];
  const lows   = result.indicators?.quote?.[0]?.low || [];

  const bars = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (closes[i] == null) continue;
    bars.push({
      t: timestamps[i] * 1000,
      o: opens[i] ?? closes[i],
      h: highs[i] ?? closes[i],
      l: lows[i] ?? closes[i],
      c: closes[i],
    });
  }
  return bars.slice(-60);
}

// ── Routes ──
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/quote/:asset', async (req, res) => {
  try {
    const data = await getQuote(decodeURIComponent(req.params.asset));
    res.json({ ok: true, data });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/history/:asset', async (req, res) => {
  try {
    const bars = await getHistory(decodeURIComponent(req.params.asset));
    res.json({ ok: true, bars });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get('/api/analyze/:asset', async (req, res) => {
  try {
    const asset = decodeURIComponent(req.params.asset);
    const [quote, bars] = await Promise.all([getQuote(asset), getHistory(asset)]);
    res.json({ ok: true, quote, bars });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Signal AI server running on port ${PORT}`));
