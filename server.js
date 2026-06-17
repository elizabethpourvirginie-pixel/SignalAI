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

// ════════════ CONFLUENCE SCORING ════════════
// Each indicator votes bullish(+1)/bearish(-1)/neutral(0). We aggregate.
function analyzeBars(bars) {
  const closes = bars.map(b=>b.c);
  const vols = bars.map(b=>b.v);
  const price = closes[closes.length-1];
  const signals = [];

  // 1. RSI
  const r = rsi(closes,14);
  if (r!==null) {
    let vote=0, note="";
    if (r<30){vote=1;note=`RSI ${r.toFixed(0)} — oversold, bounce likely`;}
    else if (r>70){vote=-1;note=`RSI ${r.toFixed(0)} — overbought, pullback risk`;}
    else if (r<45){vote=0.5;note=`RSI ${r.toFixed(0)} — leaning oversold`;}
    else if (r>55){vote=-0.5;note=`RSI ${r.toFixed(0)} — leaning overbought`;}
    else {vote=0;note=`RSI ${r.toFixed(0)} — neutral`;}
    signals.push({name:"RSI",vote,note,value:r.toFixed(1)});
  }

  // 2. MACD
  const m = macd(closes);
  if (m!==null) {
    let vote = m.hist>0?1:-1;
    const note = m.hist>0?`MACD bullish (histogram +${m.hist.toFixed(4)})`:`MACD bearish (histogram ${m.hist.toFixed(4)})`;
    signals.push({name:"MACD",vote,note,value:m.hist.toFixed(4)});
  }

  // 3. Moving average alignment (price vs SMA20 vs SMA50)
  const s20=sma(closes,20), s50=sma(closes,50);
  if (s20!==null && s50!==null) {
    let vote=0, note="";
    if (price>s20 && s20>s50){vote=1;note="Price > MA20 > MA50 — clean uptrend";}
    else if (price<s20 && s20<s50){vote=-1;note="Price < MA20 < MA50 — clean downtrend";}
    else if (price>s20){vote=0.5;note="Price above MA20 — short-term bullish";}
    else {vote=-0.5;note="Price below MA20 — short-term bearish";}
    signals.push({name:"MA Trend",vote,note,value:`${s20.toFixed(2)}/${s50.toFixed(2)}`});
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
    signals.push({name:"Bollinger",vote,note,value:`${(pos*100).toFixed(0)}%`});
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
    signals.push({name:"Volume",vote,note,value:`${ratio.toFixed(1)}x`});
  }

  // 6. Recent momentum (rate of change over 10 bars)
  if (closes.length>=10) {
    const roc=((price-closes[closes.length-10])/closes[closes.length-10])*100;
    let vote=Math.max(-1,Math.min(1,roc/2));
    signals.push({name:"Momentum",vote,note:`10-bar ROC ${roc>0?"+":""}${roc.toFixed(2)}%`,value:`${roc.toFixed(2)}%`});
  }

  return { signals, price, atr: atr(bars,14) };
}

// Combine single-timeframe signals into a score
function scoreSignals(signals) {
  if (!signals.length) return { score:0, bullVotes:0, bearVotes:0, total:0 };
  let sum=0, bull=0, bear=0;
  signals.forEach(s=>{
    sum+=s.vote;
    if(s.vote>0.25)bull++;
    else if(s.vote<-0.25)bear++;
  });
  // Normalize to -100..100
  const score=Math.round((sum/signals.length)*100);
  return { score, bullVotes:bull, bearVotes:bear, total:signals.length };
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
  const s1=a1?scoreSignals(a1.signals):null;
  const s15=a15?scoreSignals(a15.signals):null;
  const s60=a60?scoreSignals(a60.signals):null;
  return {
    short: a1?{...s1, signals:a1.signals, label:"Short-term (5m)"}:null,
    medium: a15?{...s15, signals:a15.signals, label:"Swing (15m)"}:null,
    long: a60?{...s60, signals:a60.signals, label:"Trend (1h)"}:null,
    bars: tf1.length?tf1.slice(-60):(tf15.length?tf15.slice(-60):[]),
    atr: a1?a1.atr:(a15?a15.atr:(a60?a60.atr:null)),
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
    const s=scoreSignals(a.signals);
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

// ════════════ QUOTE ════════════
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

// ════════════ ROUTES ════════════
app.get('/health',(req,res)=>res.json({status:'ok',time:new Date().toISOString()}));

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
    let mtf, verdict;
    try {
      mtf=await multiTimeframe(ticker);
      verdict=finalVerdict(mtf);
    } catch(e) {
      mtf={short:null,medium:null,long:null,bars:[],atr:null};
      verdict=null;
    }
    // Fallback verdict from daily change if indicators unavailable
    if(!verdict){
      const ch=parseFloat(quote.changePct);
      let signal=ch>1?"BUY":ch<-1?"SELL":"NEUTRAL";
      verdict={signal,confidence:50,score:Math.round(ch*10),allAgree:false,majorityAgree:false,fallback:true};
    }
    res.json({ok:true, quote, mtf, verdict, bars:mtf.bars});
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
