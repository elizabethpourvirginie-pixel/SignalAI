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
const CLASS_ASSETS = {
  stocks:["AAPL","NVDA","MSFT","TSLA","AMZN","META","GOOGL","AMD"],
  forex:["EUR/USD","GBP/USD","USD/JPY","AUD/USD","USD/CAD","EUR/GBP"],
  crypto:["BTC/USD","ETH/USD","SOL/USD","BNB/USD","XRP/USD","ADA/USD"],
  commodities:["GOLD","SILVER","OIL (WTI)","BRENT","NATURAL GAS","COPPER"],
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

function barsFromResult(result) {
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null) continue;
    bars.push({ t: ts[i]*1000, o:q.open?.[i]??q.close[i], h:q.high?.[i]??q.close[i], l:q.low?.[i]??q.close[i], c:q.close[i], v:q.volume?.[i]??0 });
  }
  return bars;
}

// ════════════ TECHNICAL INDICATORS ════════════
function sma(vals, period) {
  if (vals.length < period) return null;
  const slice = vals.slice(-period);
  return slice.reduce((a,b)=>a+b,0)/period;
}
function ema(vals, period) {
  if (vals.length < period) return null;
  const k = 2/(period+1);
  let e = vals.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period;i<vals.length;i++) e = vals[i]*k + e*(1-k);
  return e;
}
function emaSeries(vals, period) {
  if (vals.length < period) return [];
  const k=2/(period+1);
  const out=[];
  let e=vals.slice(0,period).reduce((a,b)=>a+b,0)/period;
  out.push(e);
  for(let i=period;i<vals.length;i++){e=vals[i]*k+e*(1-k);out.push(e);}
  return out;
}
function rsi(closes, period=14) {
  if (closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=closes.length-period;i<closes.length;i++){
    const diff=closes[i]-closes[i-1];
    if(diff>=0)gains+=diff; else losses-=diff;
  }
  const avgG=gains/period, avgL=losses/period;
  if(avgL===0)return 100;
  const rs=avgG/avgL;
  return 100-(100/(1+rs));
}
function macd(closes) {
  if (closes.length < 35) return null;
  const e12=emaSeries(closes,12);
  const e26=emaSeries(closes,26);
  const offset=e12.length-e26.length;
  const macdLine=[];
  for(let i=0;i<e26.length;i++) macdLine.push(e12[i+offset]-e26[i]);
  const signalLine=emaSeries(macdLine,9);
  const m=macdLine[macdLine.length-1];
  const s=signalLine[signalLine.length-1];
  return { macd:m, signal:s, hist:m-s };
}
function bollinger(closes, period=20, mult=2) {
  if (closes.length < period) return null;
  const slice=closes.slice(-period);
  const mean=slice.reduce((a,b)=>a+b,0)/period;
  const variance=slice.reduce((a,b)=>a+(b-mean)**2,0)/period;
  const sd=Math.sqrt(variance);
  return { upper:mean+mult*sd, mid:mean, lower:mean-mult*sd, price:closes[closes.length-1] };
}
function atr(bars, period=14) {
  if (bars.length < period+1) return null;
  let sum=0;
  for(let i=bars.length-period;i<bars.length;i++){
    const tr=Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-bars[i-1].c), Math.abs(bars[i].l-bars[i-1].c));
    sum+=tr;
  }
  return sum/period;
}

// Support/Resistance from swing highs and lows
function supportResistance(bars, lookback=3) {
  if (bars.length < lookback*2+1) return { supports:[], resistances:[] };
  const highs=[], lows=[];
  for (let i=lookback;i<bars.length-lookback;i++){
    let isHigh=true, isLow=true;
    for (let j=1;j<=lookback;j++){
      if (bars[i].h<bars[i-j].h||bars[i].h<bars[i+j].h) isHigh=false;
      if (bars[i].l>bars[i-j].l||bars[i].l>bars[i+j].l) isLow=false;
    }
    if (isHigh) highs.push(bars[i].h);
    if (isLow) lows.push(bars[i].l);
  }
  const price=bars[bars.length-1].c;
  // Cluster nearby levels (within 0.3%)
  function cluster(levels){
    levels.sort((a,b)=>a-b);
    const out=[];
    for(const l of levels){
      const last=out[out.length-1];
      if(last&&Math.abs(l-last.price)/last.price<0.003){last.price=(last.price*last.count+l)/(last.count+1);last.count++;}
      else out.push({price:l,count:1});
    }
    return out.sort((a,b)=>b.count-a.count);
  }
  const res=cluster(highs).filter(r=>r.price>price).slice(0,3);
  const sup=cluster(lows).filter(s=>s.price<price).slice(0,3);
  return { supports:sup.map(s=>+s.price.toFixed(price>100?2:5)), resistances:res.map(r=>+r.price.toFixed(price>100?2:5)) };
}

// ════════════ #1 CANDLESTICK & CHART PATTERNS ════════════
function detectPatterns(bars) {
  if (bars.length < 5) return [];
  const patterns = [];
  const n = bars.length;
  const last = bars[n-1], prev = bars[n-2], prev2 = bars[n-3];

  const body = b => Math.abs(b.c - b.o);
  const range = b => (b.h - b.l) || 1e-9;
  const upWick = b => b.h - Math.max(b.o, b.c);
  const dnWick = b => Math.min(b.o, b.c) - b.l;
  const isBull = b => b.c > b.o;
  const isBear = b => b.c < b.o;

  // Bullish engulfing
  if (isBear(prev) && isBull(last) && last.c >= prev.o && last.o <= prev.c && body(last) > body(prev)) {
    patterns.push({ name:"Bullish Engulfing", bias:1, strength:"strong", note:"Buyers overwhelmed sellers — reversal up signal" });
  }
  // Bearish engulfing
  if (isBull(prev) && isBear(last) && last.o >= prev.c && last.c <= prev.o && body(last) > body(prev)) {
    patterns.push({ name:"Bearish Engulfing", bias:-1, strength:"strong", note:"Sellers overwhelmed buyers — reversal down signal" });
  }
  // Hammer (bullish pin bar)
  if (dnWick(last) > body(last)*2 && upWick(last) < body(last)*0.5 && body(last) > 0) {
    patterns.push({ name:"Hammer", bias:1, strength:"moderate", note:"Long lower wick — buyers rejected lower prices" });
  }
  // Shooting star (bearish pin bar)
  if (upWick(last) > body(last)*2 && dnWick(last) < body(last)*0.5 && body(last) > 0) {
    patterns.push({ name:"Shooting Star", bias:-1, strength:"moderate", note:"Long upper wick — sellers rejected higher prices" });
  }
  // Doji (indecision)
  if (body(last) < range(last)*0.1) {
    patterns.push({ name:"Doji", bias:0, strength:"weak", note:"Indecision — potential turning point, wait for confirmation" });
  }
  // Morning star (3-bar bullish reversal)
  if (n>=3 && isBear(prev2) && body(prev) < body(prev2)*0.5 && isBull(last) && last.c > (prev2.o+prev2.c)/2) {
    patterns.push({ name:"Morning Star", bias:1, strength:"strong", note:"Three-bar bottoming pattern — strong reversal up" });
  }
  // Evening star (3-bar bearish reversal)
  if (n>=3 && isBull(prev2) && body(prev) < body(prev2)*0.5 && isBear(last) && last.c < (prev2.o+prev2.c)/2) {
    patterns.push({ name:"Evening Star", bias:-1, strength:"strong", note:"Three-bar topping pattern — strong reversal down" });
  }

  // Double top / bottom (over last ~20 bars)
  if (n >= 20) {
    const recent = bars.slice(-20);
    const highsArr = recent.map(b=>b.h);
    const lowsArr = recent.map(b=>b.l);
    const maxH = Math.max(...highsArr);
    const minL = Math.min(...lowsArr);
    const highPeaks = recent.filter(b => Math.abs(b.h-maxH)/maxH < 0.004).length;
    const lowTroughs = recent.filter(b => Math.abs(b.l-minL)/minL < 0.004).length;
    if (highPeaks >= 2 && last.c < maxH*0.99) {
      patterns.push({ name:"Double Top", bias:-1, strength:"strong", note:"Price rejected same resistance twice — bearish" });
    }
    if (lowTroughs >= 2 && last.c > minL*1.01) {
      patterns.push({ name:"Double Bottom", bias:1, strength:"strong", note:"Price held same support twice — bullish" });
    }
  }

  return patterns;
}

// RSI divergence — price makes new extreme but RSI doesn't (reliable reversal)
function detectDivergence(bars) {
  if (bars.length < 30) return null;
  const closes = bars.map(b=>b.c);
  const rsiSeries = [];
  for (let i=14;i<closes.length;i++){
    rsiSeries.push({ i, rsi: rsi(closes.slice(0,i+1),14), price: closes[i] });
  }
  if (rsiSeries.length < 10) return null;
  const recent = rsiSeries.slice(-15);
  // Find two price highs and two price lows
  const priceHigh1 = recent[0], priceHigh2 = recent[recent.length-1];
  // Bearish divergence: higher price high, lower RSI high
  if (priceHigh2.price > priceHigh1.price && priceHigh2.rsi < priceHigh1.rsi && priceHigh2.rsi > 55) {
    return { type:"Bearish Divergence", bias:-1, note:"Price making higher highs but momentum weakening — reversal down risk" };
  }
  // Bullish divergence: lower price low, higher RSI low
  if (priceHigh2.price < priceHigh1.price && priceHigh2.rsi > priceHigh1.rsi && priceHigh2.rsi < 45) {
    return { type:"Bullish Divergence", bias:1, note:"Price making lower lows but momentum strengthening — reversal up potential" };
  }
  return null;
}

// ════════════ #2 MARKET REGIME DETECTION ════════════
// Determines if market is TRENDING or RANGING, so we trust the right indicators.
function detectRegime(bars) {
  if (bars.length < 30) return { regime:"unknown", adx:0, note:"Insufficient data" };
  const closes = bars.map(b=>b.c);

  // ADX-style trend strength via directional movement
  let plusDM=0, minusDM=0, trSum=0;
  const period=14;
  for (let i=bars.length-period;i<bars.length;i++){
    const up = bars[i].h - bars[i-1].h;
    const dn = bars[i-1].l - bars[i].l;
    if (up>dn && up>0) plusDM+=up;
    if (dn>up && dn>0) minusDM+=dn;
    const tr=Math.max(bars[i].h-bars[i].l, Math.abs(bars[i].h-bars[i-1].c), Math.abs(bars[i].l-bars[i-1].c));
    trSum+=tr;
  }
  const plusDI = trSum?100*plusDM/trSum:0;
  const minusDI = trSum?100*minusDM/trSum:0;
  const dx = (plusDI+minusDI)?100*Math.abs(plusDI-minusDI)/(plusDI+minusDI):0;

  // Also measure how much price oscillates vs trends (efficiency ratio)
  const netMove = Math.abs(closes[closes.length-1]-closes[closes.length-period]);
  let pathSum=0;
  for (let i=closes.length-period+1;i<closes.length;i++) pathSum+=Math.abs(closes[i]-closes[i-1]);
  const efficiency = pathSum?netMove/pathSum:0;

  let regime, note;
  if (dx > 25 && efficiency > 0.35) {
    regime = plusDI>minusDI ? "trending-up" : "trending-down";
    note = `Strong ${plusDI>minusDI?"up":"down"}trend (ADX ${dx.toFixed(0)}). Trust trend/momentum signals; ignore mean-reversion.`;
  } else if (dx < 20 || efficiency < 0.25) {
    regime = "ranging";
    note = `Choppy/ranging market (ADX ${dx.toFixed(0)}). Trust RSI & Bollinger reversals; ignore breakout signals.`;
  } else {
    regime = "transitioning";
    note = `Transitioning (ADX ${dx.toFixed(0)}). Mixed conditions — reduce position size, wait for clarity.`;
  }
  return { regime, adx:+dx.toFixed(1), efficiency:+efficiency.toFixed(2), plusDI:+plusDI.toFixed(1), minusDI:+minusDI.toFixed(1), note };
}

// ════════════ CONFLUENCE SCORING ════════════
// Each indicator votes bullish(+1)/bearish(-1)/neutral(0). We aggregate.
function analyzeBars(bars) {
  const closes = bars.map(b=>b.c);
  const vols = bars.map(b=>b.v);
  const price = closes[closes.length-1];
  const signals = [];
  // type: "trend" works in trending markets, "reversion" works in ranging markets, "both" always
  const TYPE = { RSI:"reversion", MACD:"trend", "MA Trend":"trend", Bollinger:"reversion", Volume:"both", Momentum:"trend" };

  // 1. RSI
  const r = rsi(closes,14);
  if (r!==null) {
    let vote=0, note="";
    if (r<30){vote=1;note=`RSI ${r.toFixed(0)} — oversold, bounce likely`;}
    else if (r>70){vote=-1;note=`RSI ${r.toFixed(0)} — overbought, pullback risk`;}
    else if (r<45){vote=0.5;note=`RSI ${r.toFixed(0)} — leaning oversold`;}
    else if (r>55){vote=-0.5;note=`RSI ${r.toFixed(0)} — leaning overbought`;}
    else {vote=0;note=`RSI ${r.toFixed(0)} — neutral`;}
    signals.push({name:"RSI",vote,note,value:r.toFixed(1),type:TYPE.RSI});
  }

  // 2. MACD
  const m = macd(closes);
  if (m!==null) {
    let vote = m.hist>0?1:-1;
    const note = m.hist>0?`MACD bullish (histogram +${m.hist.toFixed(4)})`:`MACD bearish (histogram ${m.hist.toFixed(4)})`;
    signals.push({name:"MACD",vote,note,value:m.hist.toFixed(4),type:TYPE.MACD});
  }

  // 3. Moving average alignment (price vs SMA20 vs SMA50)
  const s20=sma(closes,20), s50=sma(closes,50);
  if (s20!==null && s50!==null) {
    let vote=0, note="";
    if (price>s20 && s20>s50){vote=1;note="Price > MA20 > MA50 — clean uptrend";}
    else if (price<s20 && s20<s50){vote=-1;note="Price < MA20 < MA50 — clean downtrend";}
    else if (price>s20){vote=0.5;note="Price above MA20 — short-term bullish";}
    else {vote=-0.5;note="Price below MA20 — short-term bearish";}
    signals.push({name:"MA Trend",vote,note,value:`${s20.toFixed(2)}/${s50.toFixed(2)}`,type:TYPE["MA Trend"]});
  }

  // 4. Bollinger Bands
  const bb=bollinger(closes,20,2);
  if (bb!==null) {
    let vote=0, note="";
    const pos=(price-bb.lower)/(bb.upper-bb.lower);
    if (price<=bb.lower){vote=1;note="Price at lower band — stretched, mean-reversion up";}
    else if (price>=bb.upper){vote=-1;note="Price at upper band — stretched, mean-reversion down";}
    else if (pos<0.3){vote=0.5;note="Lower third of band — leaning up";}
    else if (pos>0.7){vote=-0.5;note="Upper third of band — leaning down";}
    else {vote=0;note="Mid-band — no edge";}
    signals.push({name:"Bollinger",vote,note,value:`${(pos*100).toFixed(0)}%`,type:TYPE.Bollinger});
  }

  // 5. Volume confirmation (recent vs average)
  const avgVol=sma(vols,20);
  const recentVol=vols[vols.length-1];
  if (avgVol!==null && avgVol>0) {
    const ratio=recentVol/avgVol;
    const priceUp=closes[closes.length-1]>closes[closes.length-2];
    let vote=0, note="";
    if (ratio>1.5){vote=priceUp?1:-1;note=`Volume ${ratio.toFixed(1)}x avg — strong conviction ${priceUp?"up":"down"}`;}
    else if (ratio<0.6){vote=0;note=`Volume ${ratio.toFixed(1)}x avg — weak, move unreliable`;}
    else {vote=priceUp?0.3:-0.3;note=`Volume ${ratio.toFixed(1)}x avg — normal`;}
    signals.push({name:"Volume",vote,note,value:`${ratio.toFixed(1)}x`,type:TYPE.Volume});
  }

  // 6. Recent momentum (rate of change over 10 bars)
  if (closes.length>=10) {
    const roc=((price-closes[closes.length-10])/closes[closes.length-10])*100;
    let vote=Math.max(-1,Math.min(1,roc/2));
    signals.push({name:"Momentum",vote,note:`10-bar ROC ${roc>0?"+":""}${roc.toFixed(2)}%`,value:`${roc.toFixed(2)}%`,type:TYPE.Momentum});
  }

  const regime = detectRegime(bars);
  const patterns = detectPatterns(bars);
  const divergence = detectDivergence(bars);
  return { signals, price, atr: atr(bars,14), regime, patterns, divergence };
}

// Combine signals into a score — REGIME-AWARE (#2) + pattern/divergence boost
function scoreSignals(signals, regime, patterns, divergence) {
  if (!signals.length) return { score:0, bullVotes:0, bearVotes:0, total:0 };
  let sum=0, bull=0, bear=0, weightSum=0;

  // Regime weighting: in a trend, trend-signals count more; in a range, reversion-signals count more
  const reg = regime ? regime.regime : "unknown";
  function weightFor(type) {
    if (reg === "trending-up" || reg === "trending-down") {
      if (type === "trend") return 1.5;
      if (type === "reversion") return 0.5;  // mean-reversion fails in trends
      return 1;
    } else if (reg === "ranging") {
      if (type === "reversion") return 1.5;
      if (type === "trend") return 0.5;       // trend signals fail in ranges
      return 1;
    }
    return 1; // transitioning/unknown: equal weight
  }

  signals.forEach(s=>{
    const w = weightFor(s.type);
    sum += s.vote * w;
    weightSum += w;
    if(s.vote>0.25)bull++;
    else if(s.vote<-0.25)bear++;
  });

  let score = weightSum ? (sum/weightSum)*100 : 0;

  // Pattern boost: strong candlestick/chart patterns nudge the score
  if (patterns && patterns.length) {
    patterns.forEach(p=>{
      const mag = p.strength==="strong"?12:p.strength==="moderate"?7:3;
      score += p.bias * mag;
    });
  }
  // Divergence is a high-quality signal
  if (divergence) score += divergence.bias * 15;

  score = Math.max(-100, Math.min(100, score));
  return { score:Math.round(score), bullVotes:bull, bearVotes:bear, total:signals.length };
}

// ════════════ MULTI-TIMEFRAME ════════════
async function safeChart(ticker, range, interval) {
  try { return barsFromResult(await fetchChart(ticker, range, interval)); }
  catch(e) { return []; }
}
async function multiTimeframe(ticker) {
  // Use intervals Yahoo reliably supports across stocks/forex/crypto/commodities.
  // 5m (not 2m — 2m is often rejected for FX/futures), 15m, 1h.
  let [tf1, tf15, tf60] = await Promise.all([
    safeChart(ticker,"1d","5m"),
    safeChart(ticker,"5d","15m"),
    safeChart(ticker,"1mo","1h"),
  ]);
  // Fallbacks if any came back empty
  if (tf1.length < 35) tf1 = await safeChart(ticker,"5d","15m");
  if (tf15.length < 35) tf15 = await safeChart(ticker,"1mo","1h");
  if (tf60.length < 35) tf60 = await safeChart(ticker,"3mo","1d");

  const a1=tf1.length>35?analyzeBars(tf1):null;
  const a15=tf15.length>35?analyzeBars(tf15):null;
  const a60=tf60.length>35?analyzeBars(tf60):null;
  const s1=a1?scoreSignals(a1.signals,a1.regime,a1.patterns,a1.divergence):null;
  const s15=a15?scoreSignals(a15.signals,a15.regime,a15.patterns,a15.divergence):null;
  const s60=a60?scoreSignals(a60.signals,a60.regime,a60.patterns,a60.divergence):null;
  return {
    short: a1?{...s1, signals:a1.signals, regime:a1.regime, patterns:a1.patterns, divergence:a1.divergence, label:"Short-term (5m)"}:null,
    medium: a15?{...s15, signals:a15.signals, regime:a15.regime, patterns:a15.patterns, divergence:a15.divergence, label:"Swing (15m)"}:null,
    long: a60?{...s60, signals:a60.signals, regime:a60.regime, patterns:a60.patterns, divergence:a60.divergence, label:"Trend (1h)"}:null,
    bars: tf1.length?tf1.slice(-60):(tf15.length?tf15.slice(-60):[]),
    atr: a1?a1.atr:(a15?a15.atr:(a60?a60.atr:null)),
    // Primary regime = the swing (15m) timeframe, the most tradeable
    regime: a15?a15.regime:(a1?a1.regime:(a60?a60.regime:null)),
  };
}

// Final verdict combining all timeframes
function finalVerdict(mtf) {
  const tfs=[mtf.short,mtf.medium,mtf.long].filter(Boolean);
  if(!tfs.length)return null;
  // Weight: trend 1h most, then 15m, then intraday
  const weights={short:0.25,medium:0.35,long:0.40};
  let weighted=0, wsum=0;
  if(mtf.short){weighted+=mtf.short.score*weights.short;wsum+=weights.short;}
  if(mtf.medium){weighted+=mtf.medium.score*weights.medium;wsum+=weights.medium;}
  if(mtf.long){weighted+=mtf.long.score*weights.long;wsum+=weights.long;}
  const final=weighted/wsum;

  // Agreement check — do timeframes point the same way?
  const dirs=tfs.map(t=>t.score>15?1:t.score<-15?-1:0);
  const allAgree=dirs.every(d=>d===dirs[0]&&d!==0);
  const majorityAgree=Math.abs(dirs.reduce((a,b)=>a+b,0))>=2;

  // Signal only fires strong if timeframes align
  let signal, confidence;
  if(final>40&&allAgree){signal="STRONG BUY";confidence=Math.min(88,72+Math.abs(final)/8);}
  else if(final>20&&majorityAgree){signal="BUY";confidence=Math.min(78,62+Math.abs(final)/8);}
  else if(final<-40&&allAgree){signal="STRONG SELL";confidence=Math.min(88,72+Math.abs(final)/8);}
  else if(final<-20&&majorityAgree){signal="SELL";confidence=Math.min(78,62+Math.abs(final)/8);}
  else {signal="NEUTRAL";confidence=Math.round(45+Math.abs(final)/4);}

  return { signal, confidence:Math.round(confidence), score:Math.round(final), allAgree, majorityAgree };
}

// ════════════ BACKTEST ════════════
// Walk historical bars, apply the same confluence logic, measure win rate
async function backtest(ticker) {
  const result = await fetchChart(ticker,"1mo","1h").then(barsFromResult);
  if (result.length < 80) return null;
  const closes = result.map(b=>b.c);
  let trades=0, wins=0, totalR=0;
  const horizon=8; // bars to hold
  for (let i=50;i<result.length-horizon;i++){
    const window=result.slice(0,i+1);
    const a=analyzeBars(window);
    const s=scoreSignals(a.signals,a.regime,a.patterns,a.divergence);
    if (Math.abs(s.score)<25) continue; // only take strong setups
    const entry=closes[i];
    const exit=closes[i+horizon];
    const dir=s.score>0?1:-1;
    const ret=dir*((exit-entry)/entry);
    trades++;
    if(ret>0)wins++;
    totalR+=ret;
  }
  return {
    trades,
    winRate: trades?Math.round((wins/trades)*100):0,
    avgReturn: trades?(totalR/trades*100).toFixed(2):0,
    period:"30 days (1h bars)",
    horizon:`${horizon} hours hold`,
  };
}

// ════════════ TRACK RECORD ════════════
// Reconstructs the bot's REAL historical performance by replaying the exact
// confluence strategy over each asset's actual price history. This is honest:
// it shows how the signals WOULD have performed, computed from real data,
// not cherry-picked or fabricated.
async function trackRecord(cls) {
  const assets = CLASS_ASSETS[cls];
  if (!assets) return null;
  const perAsset = [];
  let totalTrades=0, totalWins=0, totalRet=0;

  for (let i=0;i<assets.length;i+=2){
    const batch=assets.slice(i,i+2);
    const results=await Promise.allSettled(batch.map(async a=>{
      const ticker=SYMBOL_MAP[a];
      const bt=await backtest(ticker);
      return { asset:a, ...bt };
    }));
    results.forEach(r=>{
      if(r.status==="fulfilled"&&r.value&&r.value.trades>0){
        perAsset.push(r.value);
        totalTrades+=r.value.trades;
        totalWins+=Math.round(r.value.trades*r.value.winRate/100);
        totalRet+=parseFloat(r.value.avgReturn)*r.value.trades;
      }
    });
    if(i+2<assets.length)await new Promise(r=>setTimeout(r,300));
  }

  perAsset.sort((a,b)=>b.winRate-a.winRate);
  return {
    overall: {
      trades: totalTrades,
      winRate: totalTrades?Math.round((totalWins/totalTrades)*100):0,
      avgReturn: totalTrades?(totalRet/totalTrades).toFixed(2):0,
    },
    perAsset,
    period: "30 days, 1h bars",
    note: "Strategy replayed on real historical price data. Honest reconstruction — not a promise of future results.",
  };
}

// Quote
async function getQuote(asset) {
  const now=Date.now();
  if(cache[asset]&&(now-cache[asset].ts)<CACHE_TTL)return cache[asset].data;
  const ticker=SYMBOL_MAP[asset];
  if(!ticker)throw new Error(`Unknown asset: ${asset}`);
  const result=await fetchChart(ticker,"5d","1d");
  const meta=result.meta;
  const price=meta.regularMarketPrice;
  const prev=meta.previousClose||meta.chartPreviousClose||price;
  const open=meta.regularMarketOpen??prev;
  const high=meta.regularMarketDayHigh??Math.max(price,prev);
  const low=meta.regularMarketDayLow??Math.min(price,prev);
  const change=price-prev;
  const changePct=prev?((change/prev)*100).toFixed(2):"0.00";
  const data={asset,ticker,price,open,high,low,prev,change:change.toFixed(4),changePct,currency:meta.currency||"USD",marketState:meta.marketState||"REGULAR",timestamp:new Date().toISOString()};
  cache[asset]={ts:now,data};
  return data;
}

// ════════════ #4 CROSS-ASSET CORRELATION ════════════
// Known relationships: confirm a signal if correlated assets agree.
const CORRELATIONS = {
  "GOLD":      [{asset:"SILVER",rel:1},{asset:"EUR/USD",rel:1}],   // gold up often = dollar weak = EURUSD up
  "SILVER":    [{asset:"GOLD",rel:1}],
  "OIL (WTI)": [{asset:"BRENT",rel:1}],
  "BRENT":     [{asset:"OIL (WTI)",rel:1}],
  "BTC/USD":   [{asset:"ETH/USD",rel:1},{asset:"SOL/USD",rel:1}],
  "ETH/USD":   [{asset:"BTC/USD",rel:1}],
  "SOL/USD":   [{asset:"BTC/USD",rel:1}],
  "EUR/USD":   [{asset:"GBP/USD",rel:1}],
  "GBP/USD":   [{asset:"EUR/USD",rel:1}],
  "NVDA":      [{asset:"AMD",rel:1}],
  "AMD":       [{asset:"NVDA",rel:1}],
};

async function correlationCheck(asset, ownDir) {
  const corr = CORRELATIONS[asset];
  if (!corr || ownDir === 0) return null;
  const checks = await Promise.allSettled(corr.map(async c=>{
    const q = await getQuote(c.asset);
    const ch = parseFloat(q.changePct);
    const peerDir = ch>0.2?1:ch<-0.2?-1:0;
    // Expected direction = own direction × relationship sign
    const expected = ownDir * c.rel;
    return { asset:c.asset, peerDir, expected, confirms: peerDir===expected && peerDir!==0, changePct:q.changePct };
  }));
  const valid = checks.filter(c=>c.status==="fulfilled").map(c=>c.value);
  if (!valid.length) return null;
  const confirming = valid.filter(c=>c.confirms).length;
  const conflicting = valid.filter(c=>c.peerDir!==0 && !c.confirms).length;
  return {
    confirming, conflicting, total: valid.length, peers: valid,
    verdict: confirming>conflicting ? "confirmed" : conflicting>confirming ? "conflicted" : "neutral",
  };
}

// ════════════ #5 VOLUME PROFILE ════════════
// Find price levels where most volume traded — where big players are positioned.
function volumeProfile(bars, buckets=20) {
  if (bars.length < 20) return null;
  const prices = bars.map(b=>(b.h+b.l+b.c)/3);
  const min = Math.min(...bars.map(b=>b.l));
  const max = Math.max(...bars.map(b=>b.h));
  const range = max-min || 1;
  const bins = new Array(buckets).fill(0);
  bars.forEach(b=>{
    const mid = (b.h+b.l+b.c)/3;
    const idx = Math.min(buckets-1, Math.floor(((mid-min)/range)*buckets));
    bins[idx] += b.v || 1;
  });
  // Point of Control = price level with most volume
  let pocIdx = 0;
  bins.forEach((v,i)=>{ if(v>bins[pocIdx]) pocIdx=i; });
  const poc = min + (pocIdx+0.5)*(range/buckets);
  // High-volume nodes (top 3 levels)
  const indexed = bins.map((v,i)=>({v,price:min+(i+0.5)*(range/buckets)})).sort((a,b)=>b.v-a.v);
  const nodes = indexed.slice(0,3).map(n=>+n.price.toFixed(max>100?2:5));
  return { poc:+poc.toFixed(max>100?2:5), nodes };
}

// ════════════ TELEGRAM ALERTS ════════════
const BOT_TOKEN = process.env.BOT_TOKEN || "";       // set in Render env vars
const CHANNEL_ID = process.env.CHANNEL_ID || "";     // e.g. @yourchannel or -100123...
const BIG_MOVE_PCT = parseFloat(process.env.BIG_MOVE_PCT || "3");  // alert threshold

// Track what we've already alerted to avoid spam
const alertState = {
  lastDigest: 0,
  movedToday: {},      // asset -> last alerted % bucket
  lastNewsHash: {},    // asset -> last headline alerted
};

async function tgSend(text) {
  if (!BOT_TOKEN || !CHANNEL_ID) {
    console.log("[ALERT skipped — no BOT_TOKEN/CHANNEL_ID]:", text.slice(0,60));
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHANNEL_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
    const j = await res.json();
    if (!j.ok) console.error("Telegram error:", j.description);
    return j.ok;
  } catch (e) {
    console.error("tgSend error:", e.message);
    return false;
  }
}

// Scan all categories for big intraday moves
async function checkBigMoves() {
  const allAssets = Object.values(CLASS_ASSETS).flat();
  for (let i = 0; i < allAssets.length; i += 3) {
    const batch = allAssets.slice(i, i + 3);
    await Promise.allSettled(batch.map(async (asset) => {
      try {
        const q = await getQuote(asset);
        const ch = parseFloat(q.changePct);
        const absCh = Math.abs(ch);
        if (absCh >= BIG_MOVE_PCT) {
          // Only alert once per 1% bucket per day to avoid spam
          const bucket = Math.floor(absCh);
          if (alertState.movedToday[asset] !== bucket) {
            alertState.movedToday[asset] = bucket;
            const dir = ch >= 0 ? "🟢 UP" : "🔴 DOWN";
            const arrow = ch >= 0 ? "▲" : "▼";
            await tgSend(
              `⚡ <b>BIG MOVE ALERT</b>\n\n` +
              `<b>${asset}</b> is ${dir} ${arrow} <b>${ch >= 0 ? "+" : ""}${q.changePct}%</b> today\n` +
              `Price: <b>${fmtNum(q.price)}</b>\n\n` +
              `<i>Volatility is elevated — manage your risk. Not financial advice.</i>`
            );
          }
        }
      } catch (e) {}
    }));
    await new Promise(r => setTimeout(r, 400));
  }
}

// Check for breaking news across major assets
async function checkBreakingNews() {
  // Sample a few key assets per category to limit API calls
  const watch = ["BTC/USD","ETH/USD","GOLD","OIL (WTI)","EUR/USD","AAPL","NVDA","TSLA"];
  for (const asset of watch) {
    try {
      const ticker = SYMBOL_MAP[asset];
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=3&quotesCount=0`;
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (!r.ok) continue;
      const json = await r.json();
      const top = (json.news || [])[0];
      if (top && top.title) {
        const hash = top.title.slice(0, 40);
        // Only alert genuinely new headlines, published within last 2 hours
        const age = top.providerPublishTime ? (Date.now() - top.providerPublishTime*1000) : Infinity;
        if (alertState.lastNewsHash[asset] !== hash && age < 2*60*60*1000) {
          alertState.lastNewsHash[asset] = hash;
          await tgSend(
            `📰 <b>MARKET NEWS — ${asset}</b>\n\n` +
            `${top.title}\n\n` +
            `<i>${top.publisher || "Source"}</i>` +
            (top.link ? `\n<a href="${top.link}">Read more →</a>` : "")
          );
        }
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {}
  }
}

// Daily digest — top 3 conviction setups per category
async function sendDailyDigest() {
  let msg = `🎯 <b>SIGNAL.AI DAILY DIGEST</b>\n<i>${new Date().toUTCString()}</i>\n\n`;
  for (const cls of Object.keys(CLASS_ASSETS)) {
    try {
      const assets = CLASS_ASSETS[cls];
      const scored = [];
      for (let i = 0; i < assets.length; i += 2) {
        const batch = assets.slice(i, i + 2);
        const results = await Promise.allSettled(batch.map(async (a) => {
          const ticker = SYMBOL_MAP[a];
          const [quote, mtf] = await Promise.all([getQuote(a), multiTimeframe(ticker)]);
          const verdict = finalVerdict(mtf);
          return { asset: a, quote, verdict };
        }));
        results.forEach(r => { if (r.status === "fulfilled" && r.value.verdict) scored.push(r.value); });
        await new Promise(r => setTimeout(r, 300));
      }
      // Rank by conviction
      scored.sort((a,b) => {
        const ca = Math.abs(a.verdict.score) + (a.verdict.allAgree?40:a.verdict.majorityAgree?15:0);
        const cb = Math.abs(b.verdict.score) + (b.verdict.allAgree?40:b.verdict.majorityAgree?15:0);
        return cb - ca;
      });
      const top = scored.slice(0, 3).filter(s => s.verdict.signal !== "NEUTRAL");
      if (top.length) {
        msg += `<b>${cls.toUpperCase()}</b>\n`;
        top.forEach(s => {
          const emoji = s.verdict.signal.includes("BUY") ? "🟢" : "🔴";
          const align = s.verdict.allAgree ? "✓ aligned" : s.verdict.majorityAgree ? "~ partial" : "mixed";
          msg += `${emoji} <b>${s.asset}</b> — ${s.verdict.signal} (${s.verdict.confidence}% · ${align})\n`;
        });
        msg += `\n`;
      }
    } catch (e) {}
  }
  msg += `<i>High-probability setups from multi-timeframe confluence. Never guaranteed. Always use a stop loss.</i>`;
  await tgSend(msg);
}

function fmtNum(n){
  if(n>=1000) return n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(n>=1) return n.toFixed(n>=100?2:4);
  return n.toFixed(5);
}

// ── Scheduler (runs on each keep-alive ping) ──
let lastBigMoveCheck = 0, lastNewsCheck = 0;
async function runScheduledTasks() {
  const now = Date.now();
  const hour = new Date().getUTCHours();

  // Reset daily trackers at midnight UTC
  const today = new Date().getUTCDate();
  if (alertState._day !== today) {
    alertState._day = today;
    alertState.movedToday = {};
    alertState.lastDigest = 0;
  }

  // Big moves: check at most every 10 min
  if (now - lastBigMoveCheck > 10*60*1000) {
    lastBigMoveCheck = now;
    checkBigMoves().catch(()=>{});
  }
  // News: check at most every 20 min
  if (now - lastNewsCheck > 20*60*1000) {
    lastNewsCheck = now;
    checkBreakingNews().catch(()=>{});
  }
  // Daily digest at 13:00 UTC (market-relevant time), once per day
  if (hour === 13 && now - alertState.lastDigest > 20*60*60*1000) {
    alertState.lastDigest = now;
    sendDailyDigest().catch(()=>{});
  }
}

// ════════════ ROUTES ════════════
// Helper: find YOUR chat ID so the bot can DM you personally.
// 1. Message your bot anything first.  2. Open this URL.  3. Copy the "id" shown.
app.get('/api/test/mychatid', async (req,res)=>{
  if(!BOT_TOKEN){return res.json({ok:false,error:"Set BOT_TOKEN in Render env vars first."});}
  try{
    const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates`);
    const j=await r.json();
    const chats=[];
    (j.result||[]).forEach(u=>{
      const c=u.message?.chat||u.channel_post?.chat;
      if(c)chats.push({id:c.id,type:c.type,name:c.title||c.first_name||c.username||""});
    });
    // Deduplicate
    const seen={}, unique=[];
    chats.forEach(c=>{if(!seen[c.id]){seen[c.id]=1;unique.push(c);}});
    if(unique.length===0){
      return res.json({ok:false,note:"No chats found. Send your bot a message first (just say 'hi'), then refresh this page."});
    }
    res.json({ok:true,note:"Copy the 'id' of your chat below and set it as CHANNEL_ID in Render.",chats:unique});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

app.get('/health',(req,res)=>{
  // Every keep-alive ping also runs the scheduler
  runScheduledTasks().catch(()=>{});
  res.json({status:'ok',time:new Date().toISOString()});
});

// Keep-alive endpoint (same as health, clearer name for the cron pinger)
app.get('/ping',(req,res)=>{
  runScheduledTasks().catch(()=>{});
  res.json({pong:true,time:new Date().toISOString()});
});

// Manual test triggers (so you can verify alerts work without waiting)
app.get('/api/test/digest', async (req,res)=>{
  try{ await sendDailyDigest(); res.json({ok:true,sent:"digest"}); }
  catch(err){ res.status(500).json({ok:false,error:err.message}); }
});
app.get('/api/test/bigmoves', async (req,res)=>{
  try{ alertState.movedToday={}; await checkBigMoves(); res.json({ok:true,sent:"bigmoves check complete"}); }
  catch(err){ res.status(500).json({ok:false,error:err.message}); }
});
app.get('/api/test/news', async (req,res)=>{
  try{ alertState.lastNewsHash={}; await checkBreakingNews(); res.json({ok:true,sent:"news check complete"}); }
  catch(err){ res.status(500).json({ok:false,error:err.message}); }
});
// Quick check that the bot can post to your channel at all
app.get('/api/test/hello', async (req,res)=>{
  const ok=await tgSend("✅ <b>SIGNAL.AI connected</b>\\nYour alert system is live. You'll receive big-move alerts, breaking news, and a daily digest here.");
  res.json({ok,note:ok?"Sent! Check your channel.":"Failed — check BOT_TOKEN and CHANNEL_ID env vars."});
});

app.get('/api/quote/:asset', async (req,res)=>{
  try{ res.json({ok:true,data:await getQuote(decodeURIComponent(req.params.asset))}); }
  catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

// Full multi-timeframe confluence analysis
app.get('/api/analyze/:asset', async (req,res)=>{
  try{
    const asset=decodeURIComponent(req.params.asset);
    const ticker=SYMBOL_MAP[asset];
    if(!ticker)throw new Error("Unknown asset");
    const quote=await getQuote(asset);
    let mtf, verdict, sr, vp, corr;
    try {
      mtf=await multiTimeframe(ticker);
      verdict=finalVerdict(mtf);
      sr=mtf.bars&&mtf.bars.length?supportResistance(mtf.bars,3):{supports:[],resistances:[]};
      vp=mtf.bars&&mtf.bars.length?volumeProfile(mtf.bars):null;
      // Cross-asset correlation check based on verdict direction
      const ownDir = verdict ? (verdict.score>15?1:verdict.score<-15?-1:0) : 0;
      corr=await correlationCheck(asset, ownDir).catch(()=>null);
    } catch(e) {
      mtf={short:null,medium:null,long:null,bars:[],atr:null,regime:null};
      verdict=null; sr={supports:[],resistances:[]}; vp=null; corr=null;
    }
    if(!verdict){
      const ch=parseFloat(quote.changePct);
      let signal=ch>1?"BUY":ch<-1?"SELL":"NEUTRAL";
      verdict={signal,confidence:50,score:Math.round(ch*10),allAgree:false,majorityAgree:false,fallback:true};
    }
    // Correlation adjusts confidence: confirmation boosts, conflict reduces
    if(corr && verdict && !verdict.fallback){
      if(corr.verdict==="confirmed") verdict.confidence=Math.min(92, verdict.confidence+6);
      else if(corr.verdict==="conflicted") verdict.confidence=Math.max(40, verdict.confidence-10);
    }
    res.json({ok:true, quote, mtf, verdict, sr, vp, corr, regime:mtf.regime, bars:mtf.bars});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

// Public track record — honest historical performance
app.get('/api/track/:cls', async (req,res)=>{
  try{
    const tr=await trackRecord(req.params.cls);
    if(!tr)return res.status(400).json({ok:false,error:"Unknown class"});
    res.json({ok:true, track:tr});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

// Backtest endpoint
app.get('/api/backtest/:asset', async (req,res)=>{
  try{
    const asset=decodeURIComponent(req.params.asset);
    const ticker=SYMBOL_MAP[asset];
    if(!ticker)throw new Error("Unknown asset");
    const bt=await backtest(ticker);
    res.json({ok:true, backtest:bt});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

// News
app.get('/api/news/:asset', async (req,res)=>{
  try{
    const asset=decodeURIComponent(req.params.asset);
    const ticker=SYMBOL_MAP[asset];
    if(!ticker)throw new Error("Unknown asset");
    const url=`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&newsCount=6&quotesCount=0`;
    const r=await fetch(url,{headers:{"User-Agent":UA}});
    if(!r.ok)throw new Error(`News error: ${r.status}`);
    const json=await r.json();
    const news=(json.news||[]).slice(0,4).map(n=>({title:n.title,publisher:n.publisher,time:n.providerPublishTime?n.providerPublishTime*1000:null,link:n.link}));
    res.json({ok:true,news});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

// Batched scan with confluence
app.get('/api/scan/:cls', async (req,res)=>{
  try{
    const assets=CLASS_ASSETS[req.params.cls];
    if(!assets)return res.status(400).json({ok:false,error:"Unknown class"});
    const out=[];
    for(let i=0;i<assets.length;i+=2){
      const batch=assets.slice(i,i+2);
      const results=await Promise.allSettled(batch.map(async a=>{
        const ticker=SYMBOL_MAP[a];
        const [quote,mtf]=await Promise.all([getQuote(a),multiTimeframe(ticker)]);
        const verdict=finalVerdict(mtf);
        return {asset:a,quote,verdict};
      }));
      results.forEach(r=>{if(r.status==="fulfilled")out.push(r.value);});
      if(i+2<assets.length)await new Promise(r=>setTimeout(r,300));
    }
    res.json({ok:true,results:out});
  }catch(err){ res.status(500).json({ok:false,error:err.message}); }
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Signal AI server running on port ${PORT}`));
