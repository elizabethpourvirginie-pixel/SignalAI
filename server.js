const express = require('express');
const cors = require('cors');
const yahooFinance = require('yahoo-finance2/dist/cjs/src/index-no-scrape.js');

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

async function getQuote(asset) {
  const now = Date.now();
  if (cache[asset] && (now - cache[asset].ts) < CACHE_TTL) return cache[asset].data;

  const ticker = SYMBOL_MAP[asset];
  if (!ticker) throw new Error(`Unknown asset: ${asset}`);

  const quote = await yahooFinance.quote(ticker);
  const price = quote.regularMarketPrice;
  const open  = quote.regularMarketOpen || price;
  const high  = quote.regularMarketDayHigh || price;
  const low   = quote.regularMarketDayLow || price;
  const prev  = quote.regularMarketPreviousClose || price;
  const change = price - prev;
  const changePct = ((change / prev) * 100).toFixed(2);

  const data = {
    asset, ticker, price, open, high, low, prev,
    change: change.toFixed(4), changePct,
    currency: quote.currency || "USD",
    marketState: quote.marketState || "REGULAR",
    timestamp: new Date().toISOString(),
  };
  cache[asset] = { ts: now, data };
  return data;
}

async function getHistory(asset) {
  const ticker = SYMBOL_MAP[asset];
  if (!ticker) throw new Error(`Unknown asset: ${asset}`);
  const now = new Date();
  const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const result = await yahooFinance.chart(ticker, { period1: from, period2: now, interval: '1m' });
  const quotes = result.quotes || [];
  return quotes.slice(-60).map(q => ({
    t: q.date ? new Date(q.date).getTime() : Date.now(),
    o: q.open, h: q.high, l: q.low, c: q.close,
  })).filter(q => q.c != null);
}

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
