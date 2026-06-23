import { useState, useEffect, useCallback, useMemo } from "react";
import { ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";

const ANALYZE_URL = "https://zfeslcgqvlwukyupvcis.supabase.co/functions/v1/smooth-endpoint";

const makeFmt = (currency) => currency === "KRW"
  ? (v) => v != null && !isNaN(v) ? Math.round(v).toLocaleString("ko-KR") + "원" : "-"
  : (v) => v != null && !isNaN(v) ? "$" + Number(v).toFixed(2) : "-";

const DEFAULT_STOCKS = {
  "005930.KS": { name: "삼성전자",   symbol: "005930.KS", currency: "KRW", base: 356000, vol: 0.025, trend: 0.001,  purchase: null },
  "SPCX":      { name: "SpaceX",     symbol: "SPCX",       currency: "USD", base: 196,    vol: 0.024, trend: -0.001, purchase: null },
};

const POPULAR = [
  { symbol: "AAPL",      name: "애플",       currency: "USD" },
  { symbol: "NVDA",      name: "엔비디아",   currency: "USD" },
  { symbol: "TSLA",      name: "테슬라",     currency: "USD" },
  { symbol: "MSFT",      name: "마이크로소프트", currency: "USD" },
  { symbol: "000660.KS", name: "SK하이닉스", currency: "KRW" },
  { symbol: "035420.KS", name: "NAVER",      currency: "KRW" },
  { symbol: "005380.KS", name: "현대차",     currency: "KRW" },
  { symbol: "051910.KS", name: "LG화학",     currency: "KRW" },
];

const addFmt = (obj) => Object.fromEntries(
  Object.entries(obj).map(([k, v]) => [k, { ...v, fmt: makeFmt(v.currency) }])
);

const loadStocks = () => {
  try {
    const saved = localStorage.getItem("sa_stocks_v2");
    if (saved) return addFmt({ ...DEFAULT_STOCKS, ...JSON.parse(saved) });
  } catch {}
  return addFmt(DEFAULT_STOCKS);
};

const saveStocks = (stocks) => {
  try {
    const toSave = Object.fromEntries(
      Object.entries(stocks).map(([k, v]) => {
        const { fmt, ...rest } = v;
        return [k, rest];
      })
    );
    localStorage.setItem("sa_stocks_v2", JSON.stringify(toSave));
  } catch {}
};

// ─── INDICATORS ───────────────────────────────────────────────────────────────
const calcSMA = (arr, n) => arr.map((_, i) => i < n-1 ? null : arr.slice(i-n+1,i+1).reduce((a,b)=>a+b)/n);
const calcEMA = (arr, n) => { const k=2/(n+1); return arr.reduce((acc,v,i)=>{acc.push(i===0?v:v*k+acc[i-1]*(1-k));return acc;},[]);};
const calcRSI = (arr, n=14) => arr.map((_,i)=>{if(i<n)return null;let g=0,l=0;for(let j=i-n+1;j<=i;j++){const d=arr[j]-arr[j-1];d>0?(g+=d):(l-=d);}return +(100-100/(1+g/(l||1e-9))).toFixed(2);});
const calcBB = (arr, n=20) => { const m=calcSMA(arr,n);return arr.map((_,i)=>{if(!m[i])return{};const std=Math.sqrt(arr.slice(i-n+1,i+1).reduce((a,v)=>a+(v-m[i])**2,0)/n);return{u:m[i]+2*std,mid:m[i],lo:m[i]-2*std};});};
const calcMACD = arr => { const e12=calcEMA(arr,12),e26=calcEMA(arr,26),line=e12.map((v,i)=>v-e26[i]),sig=calcEMA(line,9);return{line,sig,hist:line.map((v,i)=>v-sig[i])};};

function genOHLCV(stock, days=130) {
  const result=[];let p=stock.base;const start=new Date();start.setDate(start.getDate()-days-10);let trend=stock.trend||0;
  for(let i=0;i<days+20;i++){const d=new Date(start);d.setDate(d.getDate()+i);if([0,6].includes(d.getDay()))continue;if(i===30)trend=-trend;if(i===70)trend=stock.trend||0;const chg=trend+(Math.random()-0.5)*(stock.vol||0.02)+Math.sin(i*0.18)*(stock.vol||0.02)*0.3;const o=p,c=p*(1+chg);result.push({date:`${d.getMonth()+1}/${d.getDate()}`,open:o,high:Math.max(o,c)*(1+Math.random()*(stock.vol||0.02)*0.25),close:c,low:Math.min(o,c)*(1-Math.random()*(stock.vol||0.02)*0.25),volume:Math.floor(Math.random()*12e6+3e6)});p=c;}
  return result.slice(-days);
}

function buildChart(raw, stock) {
  const closes=raw.map(d=>d.close);
  const s20=calcSMA(closes,20),s60=calcSMA(closes,60),rsi=calcRSI(closes),{line:ml,sig:ms,hist:mh}=calcMACD(closes),bands=calcBB(closes);
  const dp=stock.currency==="KRW"?0:2;
  const fx=v=>(v==null||isNaN(v))?null:+v.toFixed(dp);
  return raw.map((d,i)=>({date:d.date,open:fx(d.open),high:fx(d.high),close:fx(d.close),low:fx(d.low),volume:d.volume,ma20:fx(s20[i]),ma60:fx(s60[i]),bbU:fx(bands[i]?.u),bbM:fx(bands[i]?.mid),bbL:fx(bands[i]?.lo),rsi:rsi[i],macd:fx(ml[i]),macdSig:fx(ms[i]),macdH:fx(mh[i])}));
}

function computeSignals(cd) {
  const l=cd[cd.length-1],p=cd[cd.length-2];
  if(!l||!p)return{signals:[],bullPct:50};
  const S=[],add=(type,label,detail,w)=>S.push({type,label,detail,w});
  if(l.rsi!=null){if(l.rsi<30)add("buy","RSI 과매도",`RSI ${l.rsi}`,3);else if(l.rsi>70)add("sell","RSI 과매수",`RSI ${l.rsi}`,3);else if(l.rsi<45)add("sell","RSI 약세",`RSI ${l.rsi}`,1);else add("buy","RSI 강세",`RSI ${l.rsi}`,1);}
  if(l.ma20&&l.ma60){if(l.ma20>l.ma60&&p.ma20<=p.ma60)add("buy","골든크로스!","MA20↑MA60",5);else if(l.ma20<l.ma60&&p.ma20>=p.ma60)add("sell","데드크로스!","MA20↓MA60",5);else if(l.ma20>l.ma60)add("buy","MA 정배열","MA20>MA60",1);else add("sell","MA 역배열","MA20<MA60",1);}
  if(l.macd!=null){if(l.macd>l.macdSig&&p.macd<=p.macdSig)add("buy","MACD 골든크로스","MACD↑Signal",3);else if(l.macd<l.macdSig&&p.macd>=p.macdSig)add("sell","MACD 데드크로스","MACD↓Signal",3);else if(l.macd>l.macdSig)add("buy","MACD 매수","MACD>Signal",1);else add("sell","MACD 매도","MACD<Signal",1);}
  if(l.bbU&&l.bbL){const pos=(l.close-l.bbL)/(l.bbU-l.bbL);if(l.close<l.bbL)add("buy","BB 하단 이탈",`${(pos*100).toFixed(0)}%`,2);else if(l.close>l.bbU)add("sell","BB 상단 돌파",`${(pos*100).toFixed(0)}%`,2);else if(pos<0.3)add("buy","BB 하단권",`${(pos*100).toFixed(0)}%`,1);else if(pos>0.7)add("sell","BB 상단권",`${(pos*100).toFixed(0)}%`,1);else add("neutral","BB 중립권",`${(pos*100).toFixed(0)}%`,0);}
  if(l.ma20){const pct=((l.close-l.ma20)/l.ma20*100).toFixed(1);if(l.close>l.ma20)add("buy","MA20 상단",`+${pct}%`,1);else add("sell","MA20 하단",`${pct}%`,1);}
  const bW=S.filter(s=>s.type==="buy").reduce((a,s)=>a+s.w,0),sW=S.filter(s=>s.type==="sell").reduce((a,s)=>a+s.w,0);
  return{signals:S,bullPct:bW+sW>0?Math.round(bW/(bW+sW)*100):50};
}

const nf = (v, d=2) => (v != null && !isNaN(v)) ? Number(v).toFixed(d) : "0";
const pSign = v => (v != null && !isNaN(v) && v >= 0) ? "+" : "";

function PriceTip({active,payload,label,fmt}){
  if(!active||!payload?.length)return null;
  const d=payload[0]?.payload;
  return(<div style={{background:"#1a1d27",border:"1px solid #2d3040",borderRadius:8,padding:"10px 14px",fontSize:11,color:"#e0e6ed",lineHeight:1.9}}>
    <div style={{color:"#7c8599",fontWeight:600,marginBottom:2}}>{label}</div>
    {d?.close!=null&&<div>종가 <b style={{color:"#fff"}}>{fmt(d.close)}</b></div>}
    {d?.ma20!=null&&<div>MA20 <span style={{color:"#fbbf24"}}>{fmt(d.ma20)}</span></div>}
    {d?.ma60!=null&&<div>MA60 <span style={{color:"#a78bfa"}}>{fmt(d.ma60)}</span></div>}
    {d?.bbU!=null&&<div>BB상단 <span style={{color:"#38bdf8"}}>{fmt(d.bbU)}</span></div>}
    {d?.bbL!=null&&<div>BB하단 <span style={{color:"#38bdf8"}}>{fmt(d.bbL)}</span></div>}
  </div>);
}

function IdxBadge({label,value,pct}){
  if(value==null||pct==null||isNaN(value)||isNaN(pct))return<span style={{color:"#4b5563",fontSize:12}}>{label} —</span>;
  const up=pct>=0;
  return(<span style={{fontSize:12}}><span style={{color:"#7c8599"}}>{label} </span><span style={{color:up?"#22c55e":"#ef4444",fontWeight:600}}>{Number(value).toLocaleString("ko-KR",{maximumFractionDigits:0})} {up?"▲":"▼"}{Math.abs(pct).toFixed(2)}%</span></span>);
}

export default function App() {
  const [stocks, setStocks] = useState(loadStocks);
  const [sel, setSel] = useState(Object.keys(loadStocks())[0]);
  const [range, setRange] = useState(66);
  const [chart, setChart] = useState([]);
  const [sigs, setSigs] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [dataStatus, setDataStatus] = useState("loading");
  const [indices, setIndices] = useState(null);
  const [apiMeta, setApiMeta] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addSymbol, setAddSymbol] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [purchasePrices, setPurchasePrices] = useState(() => {
    try { return JSON.parse(localStorage.getItem("sa_purchases") || "{}"); } catch { return {}; }
  });
  const [inputPurchase, setInputPurchase] = useState("");

  const stock = stocks[sel] || Object.values(stocks)[0];
  const purchasePrice = purchasePrices[sel] ?? null;

  const savePurchasePrice = (val) => {
    const price = val === "" || val == null ? null : Number(val);
    const updated = { ...purchasePrices };
    if (price == null || isNaN(price)) { delete updated[sel]; }
    else { updated[sel] = price; }
    setPurchasePrices(updated);
    localStorage.setItem("sa_purchases", JSON.stringify(updated));
  };

  // ── 주가 로드 ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!stock) return;
    setAnalysis(null); setSigs(null); setChart([]); setDataStatus("loading"); setApiMeta(null);
    fetch(ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "stock", symbol: stock.symbol }),
      signal: AbortSignal.timeout(10000),
    })
      .then(r => r.json())
      .then(json => {
        const r = json.chart?.result?.[0];
        if (!r) throw new Error("no data");
        const q = r.indicators.quote[0];
        const meta = r.meta;
        const data = r.timestamp.map((t, i) => {
          const d = new Date(t * 1000);
          return { date: `${d.getMonth()+1}/${d.getDate()}`, open: q.open[i]??0, high: q.high[i]??0, close: q.close[i], low: q.low[i]??0, volume: q.volume[i]||0 };
        }).filter(d => d.close != null && !isNaN(d.close));
        const cd = buildChart(data, stock);
        setChart(cd); setSigs(computeSignals(cd));
        setApiMeta({ currentPrice: meta.regularMarketPrice, dayChange: meta.regularMarketChange, dayChangePct: meta.regularMarketChangePercent });
        setDataStatus("real");
      })
      .catch(() => {
        const raw = genOHLCV(stock, 130);
        const cd = buildChart(raw, stock);
        setChart(cd); setSigs(computeSignals(cd));
        setDataStatus("mock");
      });
  }, [sel]);

  // ── sel 변경 시 매수가 인풋 업데이트 ─────────────────────────────────
  useEffect(() => {
    setInputPurchase(purchasePrices[sel] != null ? String(purchasePrices[sel]) : "");
  }, [sel]);

  // ── 지수 로드 ──────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "indices" }),
    }).then(r => r.json()).then(setIndices).catch(() => {});
  }, []);

  const display = useMemo(() => chart.slice(-range), [chart, range]);
  const ticks = useMemo(() => {
    if (!display.length) return [];
    const step = Math.max(1, Math.floor(display.length / 6));
    return display.filter((_, i) => i % step === 0).map(d => d.date);
  }, [display]);

  const l = chart[chart.length - 1];
  const currentPrice = (dataStatus === "real" && apiMeta?.currentPrice != null) ? apiMeta.currentPrice : (l?.close ?? 0);
  const dayChgPct = (dataStatus === "real" && apiMeta?.dayChangePct != null) ? apiMeta.dayChangePct : (l && chart[chart.length-2]?.close ? (l.close-chart[chart.length-2].close)/chart[chart.length-2].close*100 : 0);
  const dayChgAbs = (dataStatus === "real" && apiMeta?.dayChange != null) ? apiMeta.dayChange : (l && chart[chart.length-2]?.close ? l.close-chart[chart.length-2].close : 0);
  const safePct = isNaN(dayChgPct) ? 0 : (dayChgPct ?? 0);
  const safeAbs = isNaN(dayChgAbs) ? 0 : (dayChgAbs ?? 0);

  // ── 종목 추가 ──────────────────────────────────────────────────────────
  const addStock = async (sym) => {
    const symbol = (sym || addSymbol).toUpperCase().trim();
    if (!symbol) return;
    setAddLoading(true); setAddError("");
    try {
      const res = await fetch(ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stock", symbol }),
        signal: AbortSignal.timeout(10000),
      });
      const json = await res.json();
      const meta = json.chart?.result?.[0]?.meta;
      if (!meta) throw new Error("종목을 찾을 수 없습니다");
      const currency = meta.currency || (symbol.endsWith(".KS") ? "KRW" : "USD");
      const newStock = {
        name: meta.shortName || symbol,
        symbol,
        currency,
        base: meta.regularMarketPrice || 100,
        vol: 0.02,
        trend: 0,
        purchase: null,
        fmt: makeFmt(currency),
      };
      const newStocks = { ...stocks, [symbol]: newStock };
      setStocks(newStocks);
      saveStocks(newStocks);
      setSel(symbol);
      setShowAdd(false);
      setAddSymbol("");
    } catch (e) {
      setAddError(e.message || "추가 실패");
    } finally {
      setAddLoading(false);
    }
  };

  const removeStock = (symbol) => {
    if (DEFAULT_STOCKS[symbol]) return; // 기본 종목은 삭제 불가
    const newStocks = { ...stocks };
    delete newStocks[symbol];
    setStocks(newStocks);
    saveStocks(newStocks);
    if (sel === symbol) setSel(Object.keys(newStocks)[0]);
  };

  // ── 현재가 새로고침 ───────────────────────────────────────────────────
  const refreshQuote = useCallback(async (silent = false) => {
    if (!stock) return;
    if (!silent) setIsRefreshing(true);
    try {
      const res = await fetch(ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "stock", symbol: stock.symbol }),
        signal: AbortSignal.timeout(8000),
      });
      const json = await res.json();
      const meta = json.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        setApiMeta({
          currentPrice: meta.regularMarketPrice,
          dayChange: meta.regularMarketChange,
          dayChangePct: meta.regularMarketChangePercent,
        });
        setLastUpdated(new Date());
      }
      // 지수도 같이 갱신
      fetch(ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "indices" }),
      }).then(r => r.json()).then(setIndices).catch(() => {});
    } catch {}
    if (!silent) setIsRefreshing(false);
  }, [stock?.symbol]);

  // ── 60초 자동 새로고침 ────────────────────────────────────────────────
  useEffect(() => {
    if (dataStatus !== "real") return;
    setLastUpdated(new Date());
    const id = setInterval(() => refreshQuote(true), 60000);
    return () => clearInterval(id);
  }, [dataStatus, sel]);

  // ── AI 분석 ───────────────────────────────────────────────────────────
  const runAnalysis = useCallback(async () => {
    if (!l || !sigs) return;
    setAiLoading(true); setAnalysis(null);
    try {
      const today = new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric" });
      const systemPrompt = `당신은 전문 주식 애널리스트입니다. 오늘 날짜는 ${today}입니다. 한국어로 분석해주세요.
반드시 아래 JSON만 반환 (마크다운 없이, 코드블록 없이):
{"events":[{"date":"날짜 또는 기간","title":"이벤트명","impact":"positive|negative|neutral","detail":"상세설명"}],"news":[{"title":"...","sentiment":"positive|negative|neutral","impact":"..."}],"macro":["..."],"risks":["..."],"catalysts":["..."],"recommendation":"BUY|SELL|HOLD","targetPrice":"...","confidence":75,"reasoning":"..."}
events에는 오늘(${today}) 이후의 미래 일정만 포함하세요. 과거 이벤트는 절대 포함하지 마세요.
실적발표일, 지수편입일정, 락업해제, 배당일, 주주총회, 신제품출시, 규제이슈 등 주가에 영향을 줄 수 있는 향후 주요 일정을 최대 6개 포함하세요.`;
      const prompt = `${stock.name}(${stock.symbol}) 분석. 현재가: ${stock.fmt(currentPrice)} | 전일비: ${pSign(safePct)}${nf(safePct)}%${stock.purchase?` | 매수가: ${stock.fmt(purchasePrice)} (${nf((currentPrice/stock.purchase-1)*100)}%)`:""}. RSI: ${l.rsi} | 매수신호: ${sigs.bullPct}%. 최신 동향과 매수/매도/관망 의견.`;
      const res = await fetch(ANALYZE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, systemPrompt }) });
      const { text, error } = await res.json();
      if (error) throw new Error(error);
      try { setAnalysis(JSON.parse(text.replace(/```json|```/g, "").trim())); }
      catch { setAnalysis({ error: true, reasoning: text || "파싱 오류", recommendation: "HOLD", news: [], macro: [], risks: [], catalysts: [], confidence: 50 }); }
    } catch (err) {
      setAnalysis({ error: true, reasoning: err.message, recommendation: "HOLD", news: [], macro: [], risks: [], catalysts: [], confidence: 50 });
    } finally { setAiLoading(false); }
  }, [l, sigs, stock, currentPrice, safePct]);

  const sigLabel = !sigs?"—":sigs.bullPct>=65?"강한 매수":sigs.bullPct>=55?"매수 우세":sigs.bullPct>=45?"중립":sigs.bullPct>=35?"매도 우세":"강한 매도";
  const sigColor = !sigs?"#7c8599":sigs.bullPct>=60?"#22c55e":sigs.bullPct<=40?"#ef4444":"#f59e0b";
  const recColor = !analysis?"#7c8599":analysis.recommendation==="BUY"?"#22c55e":analysis.recommendation==="SELL"?"#ef4444":"#f59e0b";
  const card = { background: "#1a1d27", borderRadius: 10, border: "1px solid #2d3040", padding: "12px 14px" };
  const yfmt = v => (v==null||isNaN(v)) ? "" : stock.currency==="KRW" ? (v/1000).toFixed(0)+"k" : "$"+Number(v).toFixed(0);

  return (
    <div style={{ background: "#0f1117", color: "#e0e6ed", fontFamily: "system-ui,-apple-system,sans-serif", display: "flex", flexDirection: "column", height: "100vh" }}>

      {/* Header */}
      <div style={{ background: "#13161f", borderBottom: "1px solid #2d3040", padding: "10px 16px", display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", flexShrink: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: "#3b82f6" }}>📊 StockAnalyst</div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <IdxBadge label="KOSPI"  value={indices?.kospi?.value}  pct={indices?.kospi?.pct} />
          <IdxBadge label="NASDAQ" value={indices?.nasdaq?.value} pct={indices?.nasdaq?.pct} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
          {Object.values(stocks).map(s => (
            <div key={s.symbol} style={{ display: "flex", alignItems: "center" }}>
              <button onClick={() => setSel(s.symbol)} style={{
                padding: "5px 12px", borderRadius: DEFAULT_STOCKS[s.symbol] ? 20 : "20px 0 0 20px",
                border: `1px solid ${sel === s.symbol ? "#3b82f6" : "#2d3040"}`,
                borderRight: DEFAULT_STOCKS[s.symbol] ? undefined : "none",
                background: sel === s.symbol ? "rgba(59,130,246,0.15)" : "transparent",
                color: sel === s.symbol ? "#3b82f6" : "#7c8599", cursor: "pointer", fontSize: 12, fontWeight: sel === s.symbol ? 600 : 400,
              }}>{s.name}</button>
              {!DEFAULT_STOCKS[s.symbol] && (
                <button onClick={() => removeStock(s.symbol)} style={{
                  padding: "5px 7px", borderRadius: "0 20px 20px 0",
                  border: `1px solid ${sel === s.symbol ? "#3b82f6" : "#2d3040"}`,
                  background: sel === s.symbol ? "rgba(59,130,246,0.15)" : "transparent",
                  color: "#7c8599", cursor: "pointer", fontSize: 11,
                }}>×</button>
              )}
            </div>
          ))}
          <button onClick={() => setShowAdd(true)} style={{
            padding: "5px 12px", borderRadius: 20, border: "1px solid #2d3040",
            background: "transparent", color: "#22c55e", cursor: "pointer", fontSize: 14, fontWeight: 700,
          }}>+</button>
        </div>
      </div>

      {/* Price bar */}
      <div style={{ background: "#13161f", padding: "8px 16px", borderBottom: "1px solid #2d3040", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", flexShrink: 0, minHeight: 48 }}>
        {dataStatus === "loading"
          ? <span style={{ color: "#7c8599", fontSize: 13 }}>📡 데이터 수신 중…</span>
          : <>
            <span style={{ fontSize: 11, color: "#7c8599" }}>{stock?.symbol}</span>
            <span style={{ fontSize: 22, fontWeight: 700 }}>{stock?.fmt(currentPrice)}</span>
            <span style={{ color: safePct >= 0 ? "#22c55e" : "#ef4444", fontWeight: 600, fontSize: 13 }}>
              {safePct >= 0 ? "▲" : "▼"} {stock?.currency === "KRW" ? Math.abs(Math.round(safeAbs)).toLocaleString("ko-KR") : Math.abs(safeAbs).toFixed(2)} ({Math.abs(safePct).toFixed(2)}%)
            </span>
            {purchasePrice != null && currentPrice > 0 && (
              <span style={{ fontSize: 12, color: "#7c8599" }}>
                매수가 {stock.fmt(purchasePrice)} | <span style={{ color: currentPrice >= purchasePrice ? "#22c55e" : "#ef4444", fontWeight: 600 }}>{nf((currentPrice / purchasePrice - 1) * 100)}% {currentPrice >= purchasePrice ? "이익" : "손실"}</span>
              </span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 10, background: dataStatus === "real" ? "rgba(34,197,94,0.1)" : "rgba(245,158,11,0.1)", color: dataStatus === "real" ? "#22c55e" : "#f59e0b", border: `1px solid ${dataStatus === "real" ? "rgba(34,197,94,0.3)" : "rgba(245,158,11,0.3)"}` }}>
                {dataStatus === "real" ? "● 실시간" : "● 시뮬레이션"}
              </span>
              {[[22,"1개월"],[66,"3개월"],[130,"6개월"]].map(([r,label]) => (
                <button key={r} onClick={() => setRange(r)} style={{ padding: "3px 10px", borderRadius: 6, border: `1px solid ${range === r ? "#3b82f6" : "#2d3040"}`, background: range === r ? "rgba(59,130,246,0.1)" : "transparent", color: range === r ? "#3b82f6" : "#7c8599", cursor: "pointer", fontSize: 11 }}>{label}</button>
              ))}
              <button onClick={() => refreshQuote(false)} title="새로고침" style={{ padding: "3px 10px", borderRadius: 6, border: "1px solid #2d3040", background: "transparent", color: "#7c8599", cursor: "pointer", fontSize: 13, transition: "transform 0.3s", transform: isRefreshing ? "rotate(180deg)" : "rotate(0deg)" }}>🔄</button>
              {lastUpdated && <span style={{ fontSize: 10, color: "#4b5563" }}>{lastUpdated.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 기준</span>}
            </div>
          </>
        }
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 300px", overflow: "hidden" }}>
        {/* Charts */}
        <div style={{ overflowY: "auto", padding: "12px 10px 12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          {dataStatus === "loading" && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, flexDirection: "column", gap: 12, color: "#7c8599", paddingTop: 80 }}>
              <div style={{ fontSize: 36 }}>📡</div><div style={{ fontSize: 14 }}>데이터 로딩 중…</div>
            </div>
          )}
          {dataStatus !== "loading" && (<>
            <div style={card}>
              <div style={{ fontSize: 12, color: "#7c8599", marginBottom: 8, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600, color: "#e0e6ed" }}>가격 차트</span>
                {[["#3b82f6","종가"],["#fbbf24","MA20"],["#a78bfa","MA60"],["#38bdf8","BB"]].map(([c,label]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ display: "inline-block", width: 18, height: 2, background: c }} />{label}</span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={195}>
                <ComposedChart data={display} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040" />
                  <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#7c8599", fontSize: 10 }} />
                  <YAxis domain={["auto","auto"]} tick={{ fill: "#7c8599", fontSize: 10 }} width={52} tickFormatter={yfmt} />
                  <Tooltip content={<PriceTip fmt={stock?.fmt || (v=>v)} />} />
                  <Line type="monotone" dataKey="bbU"   stroke="#38bdf8" strokeWidth={1}   dot={false} opacity={0.55} />
                  <Line type="monotone" dataKey="bbM"   stroke="#38bdf8" strokeWidth={0.8} dot={false} opacity={0.3} strokeDasharray="4 3" />
                  <Line type="monotone" dataKey="bbL"   stroke="#38bdf8" strokeWidth={1}   dot={false} opacity={0.55} />
                  <Line type="monotone" dataKey="close" stroke="#3b82f6" strokeWidth={2}   dot={false} />
                  <Line type="monotone" dataKey="ma20"  stroke="#fbbf24" strokeWidth={1.5} dot={false} strokeDasharray="5 2" />
                  <Line type="monotone" dataKey="ma60"  stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="5 2" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{ ...card, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#7c8599", marginBottom: 6 }}>거래량</div>
              <ResponsiveContainer width="100%" height={68}>
                <ComposedChart data={display} margin={{ top: 0, right: 5, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040" />
                  <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#7c8599", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#7c8599", fontSize: 9 }} width={44} tickFormatter={v => (v/1e6).toFixed(0)+"M"} />
                  <Bar dataKey="volume" radius={[2,2,0,0]}>
                    {display.map((d,i) => <Cell key={i} fill={i===0||d.close>=(display[i-1]?.close??d.close)?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)"} />)}
                  </Bar>
                  <Tooltip contentStyle={{ background:"#1a1d27", border:"1px solid #2d3040", color:"#e0e6ed", fontSize:11 }} formatter={v => [(v/1e6).toFixed(2)+"M","거래량"]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{ ...card, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, display: "flex", gap: 10, alignItems: "center" }}>
                <span style={{ color: "#e0e6ed" }}>RSI (14)</span>
                {l?.rsi != null && <span style={{ color: l.rsi<30?"#22c55e":l.rsi>70?"#ef4444":"#f59e0b", fontSize: 13, fontWeight: 700 }}>{l.rsi}<span style={{ fontSize: 10, fontWeight: 400, color: "#7c8599", marginLeft: 5 }}>{l.rsi<30?"과매도":l.rsi>70?"과매수":"중립"}</span></span>}
              </div>
              <ResponsiveContainer width="100%" height={88}>
                <ComposedChart data={display} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040" />
                  <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#7c8599", fontSize: 9 }} />
                  <YAxis domain={[0,100]} ticks={[30,50,70]} tick={{ fill: "#7c8599", fontSize: 9 }} width={24} />
                  <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="4 3" strokeOpacity={0.5} />
                  <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="4 3" strokeOpacity={0.5} />
                  <ReferenceLine y={50} stroke="#2d3040" />
                  <Line type="monotone" dataKey="rsi" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Tooltip contentStyle={{ background:"#1a1d27", border:"1px solid #2d3040", color:"#e0e6ed", fontSize:11 }} formatter={v => [v?.toFixed(1),"RSI"]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{ ...card, padding: "10px 14px" }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, display: "flex", gap: 14, alignItems: "center" }}>
                <span style={{ color: "#e0e6ed" }}>MACD (12, 26, 9)</span>
                {[["#3b82f6","MACD"],["#f97316","Signal"]].map(([c,label]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "#7c8599" }}><span style={{ display: "inline-block", width: 14, height: 2, background: c }} />{label}</span>
                ))}
              </div>
              <ResponsiveContainer width="100%" height={88}>
                <ComposedChart data={display} margin={{ top: 5, right: 5, bottom: 5, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040" />
                  <XAxis dataKey="date" ticks={ticks} tick={{ fill: "#7c8599", fontSize: 9 }} />
                  <YAxis tick={{ fill: "#7c8599", fontSize: 9 }} width={40} />
                  <ReferenceLine y={0} stroke="#3d4660" />
                  <Bar dataKey="macdH" radius={[1,1,0,0]}>
                    {display.map((d,i) => <Cell key={i} fill={(d.macdH??0)>=0?"rgba(34,197,94,0.55)":"rgba(239,68,68,0.55)"} />)}
                  </Bar>
                  <Line type="monotone" dataKey="macd"    stroke="#3b82f6" strokeWidth={1.5} dot={false} />
                  <Line type="monotone" dataKey="macdSig" stroke="#f97316" strokeWidth={1.5} dot={false} />
                  <Tooltip contentStyle={{ background:"#1a1d27", border:"1px solid #2d3040", color:"#e0e6ed", fontSize:11 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>)}
        </div>

        {/* Analysis */}
        <div style={{ borderLeft: "1px solid #2d3040", background: "#13161f", overflowY: "auto" }}>
          {sigs && dataStatus !== "loading" && (
            <div style={{ padding: 14, borderBottom: "1px solid #2d3040" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#4b5563", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>기술적 분석</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: "#22c55e", fontWeight: 600 }}>매수 {sigs.bullPct}%</span>
                <span style={{ color: sigColor, fontWeight: 700 }}>{sigLabel}</span>
                <span style={{ color: "#ef4444", fontWeight: 600 }}>매도 {100-sigs.bullPct}%</span>
              </div>
              <div style={{ height: 7, background: "#2d3040", borderRadius: 4, overflow: "hidden", marginBottom: 12 }}>
                <div style={{ width: `${sigs.bullPct}%`, height: "100%", background: sigColor, borderRadius: 4, transition: "width 0.6s ease" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {sigs.signals.map((s, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 11, padding: "4px 6px", borderRadius: 5, background: "rgba(255,255,255,0.02)" }}>
                    <span style={{ color: s.type==="buy"?"#22c55e":s.type==="sell"?"#ef4444":"#4b5563", fontSize: 9, flexShrink: 0 }}>{s.type==="buy"?"▲":s.type==="sell"?"▼":"●"}</span>
                    <span style={{ flex: 1, color: s.type==="neutral"?"#7c8599":"#e0e6ed" }}>{s.label}</span>
                    <span style={{ color: "#4b5563", fontSize: 10 }}>{s.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {l && dataStatus !== "loading" && (
            <div style={{ padding: 14, borderBottom: "1px solid #2d3040" }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: "#4b5563", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>주요 지표</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                {[
                  { label: "현재가",  value: stock?.fmt(currentPrice) },
                  { label: "전일비",  value: `${pSign(safePct)}${nf(safePct)}%`, color: safePct>=0?"#22c55e":"#ef4444" },
                  { label: "MA 20",   value: stock?.fmt(l.ma20) },
                  { label: "MA 60",   value: stock?.fmt(l.ma60) },
                  { label: "RSI",     value: l.rsi?.toFixed(1)??"—", color: l.rsi<30?"#22c55e":l.rsi>70?"#ef4444":"#e0e6ed" },
                  { label: "MACD",    value: l.macd!=null?(stock?.currency==="KRW"?Math.round(l.macd).toLocaleString():l.macd.toFixed(3)):"—", color: (l.macd??0)>(l.macdSig??0)?"#22c55e":"#ef4444" },
                  { label: "BB 상단", value: stock?.fmt(l.bbU) },
                  { label: "BB 하단", value: stock?.fmt(l.bbL) },
                ].map(({ label, value, color }) => (
                  <div key={label} style={{ background: "#1a1d27", borderRadius: 6, padding: "7px 9px" }}>
                    <div style={{ fontSize: 9, color: "#4b5563", marginBottom: 2 }}>{label}</div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: color||"#e0e6ed", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* 매수가 설정 */}
          <div style={{ padding: 14, borderBottom: "1px solid #2d3040" }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#4b5563", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>매수가 설정</div>
            {purchasePrice != null && (
              <div style={{ fontSize: 12, color: "#7c8599", marginBottom: 8 }}>
                현재 매수가: <b style={{ color: currentPrice >= purchasePrice ? "#22c55e" : "#ef4444" }}>{stock?.fmt(purchasePrice)}</b>
                {" "}(<span style={{ color: currentPrice >= purchasePrice ? "#22c55e" : "#ef4444" }}>{pSign((currentPrice/purchasePrice-1)*100)}{nf((currentPrice/purchasePrice-1)*100)}%</span>)
              </div>
            )}
            <div style={{ display: "flex", gap: 6 }}>
              <input
                type="number"
                value={inputPurchase}
                onChange={e => setInputPurchase(e.target.value)}
                onKeyDown={e => e.key === "Enter" && savePurchasePrice(inputPurchase)}
                placeholder={stock?.currency === "KRW" ? "매수가 입력 (원)" : "매수가 입력 ($)"}
                style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #2d3040", background: "#0f1117", color: "#e0e6ed", fontSize: 12, outline: "none" }}
              />
              <button onClick={() => savePurchasePrice(inputPurchase)} style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "#3b82f6", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>저장</button>
              {purchasePrice != null && (
                <button onClick={() => { savePurchasePrice(null); setInputPurchase(""); }} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid #2d3040", background: "transparent", color: "#7c8599", cursor: "pointer", fontSize: 12 }}>×</button>
              )}
            </div>
          </div>

          <div style={{ padding: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: "#4b5563", letterSpacing: 0.8, textTransform: "uppercase", marginBottom: 10 }}>AI 분석</div>
            {!analysis && !aiLoading && dataStatus !== "loading" && (
              <button onClick={runAnalysis} style={{ width: "100%", padding: 11, borderRadius: 8, border: "1px solid #3b82f6", background: "rgba(59,130,246,0.08)", color: "#3b82f6", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>✨ AI 분석 시작</button>
            )}
            {aiLoading && (
              <div style={{ textAlign: "center", padding: "22px 0", color: "#7c8599" }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>⏳</div>
                <div style={{ fontSize: 13 }}>분석 중…</div>
              </div>
            )}
            {analysis && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* 주요 일정 */}
                {analysis.events?.length > 0 && (
                  <div style={{ background: "#1a1d27", borderRadius: 10, border: "1px solid #2d3040", padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#e0e6ed", marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                      📅 주요 일정
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {analysis.events.map((e, i) => (
                        <div key={i} style={{
                          display: "flex", gap: 10, alignItems: "flex-start",
                          padding: "7px 10px", borderRadius: 8,
                          background: e.impact === "positive" ? "rgba(34,197,94,0.06)" : e.impact === "negative" ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.03)",
                          border: `1px solid ${e.impact === "positive" ? "rgba(34,197,94,0.2)" : e.impact === "negative" ? "rgba(239,68,68,0.2)" : "rgba(255,255,255,0.06)"}`,
                        }}>
                          <div style={{ flexShrink: 0, minWidth: 52, fontSize: 10, fontWeight: 600,
                            color: e.impact === "positive" ? "#22c55e" : e.impact === "negative" ? "#ef4444" : "#f59e0b",
                            paddingTop: 1 }}>{e.date}</div>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: "#e0e6ed", lineHeight: 1.4 }}>{e.title}</div>
                            {e.detail && <div style={{ fontSize: 11, color: "#7c8599", marginTop: 2, lineHeight: 1.5 }}>{e.detail}</div>}
                          </div>
                          <div style={{ flexShrink: 0, fontSize: 14 }}>
                            {e.impact === "positive" ? "🟢" : e.impact === "negative" ? "🔴" : "🟡"}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ background: `rgba(${analysis.recommendation==="BUY"?"34,197,94":analysis.recommendation==="SELL"?"239,68,68":"245,158,11"},0.07)`, border: `1px solid ${recColor}35`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ fontSize: 17, fontWeight: 700, color: recColor, textAlign: "center" }}>{analysis.recommendation==="BUY"?"🟢 매수 (BUY)":analysis.recommendation==="SELL"?"🔴 매도 (SELL)":"🟡 관망 (HOLD)"}</div>
                  <div style={{ display: "flex", justifyContent: "center", gap: 10, marginTop: 5, fontSize: 11, color: "#7c8599" }}>
                    {analysis.confidence && <span>신뢰도 {analysis.confidence}%</span>}
                    {analysis.targetPrice && <span>목표가 <b style={{ color: recColor }}>{analysis.targetPrice}</b></span>}
                  </div>
                  {analysis.reasoning && <div style={{ fontSize: 12, color: "#b0b8c8", marginTop: 8, lineHeight: 1.7 }}>{analysis.reasoning}</div>}
                </div>
                {analysis.news?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#7c8599", marginBottom: 6 }}>최신 뉴스</div>
                    {analysis.news.map((n, i) => (
                      <div key={i} style={{ background: "#1a1d27", borderRadius: 6, padding: "7px 9px", marginBottom: 5 }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                          <span style={{ color: n.sentiment==="positive"?"#22c55e":n.sentiment==="negative"?"#ef4444":"#f59e0b", flexShrink: 0, fontSize: 10, marginTop: 1 }}>{n.sentiment==="positive"?"▲":n.sentiment==="negative"?"▼":"●"}</span>
                          <div><div style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.5 }}>{n.title}</div>{n.impact && <div style={{ fontSize: 11, color: "#7c8599", marginTop: 2 }}>{n.impact}</div>}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {(analysis.catalysts?.length > 0 || analysis.risks?.length > 0) && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    {analysis.catalysts?.length > 0 && (<div style={{ background: "rgba(34,197,94,0.05)", border: "1px solid rgba(34,197,94,0.15)", borderRadius: 8, padding: "8px 10px" }}><div style={{ fontSize: 11, fontWeight: 600, color: "#22c55e", marginBottom: 5 }}>상승 촉매</div>{analysis.catalysts.map((c,i) => <div key={i} style={{ fontSize: 11, color: "#b0b8c8", marginBottom: 3 }}>• {c}</div>)}</div>)}
                    {analysis.risks?.length > 0 && (<div style={{ background: "rgba(239,68,68,0.05)", border: "1px solid rgba(239,68,68,0.15)", borderRadius: 8, padding: "8px 10px" }}><div style={{ fontSize: 11, fontWeight: 600, color: "#ef4444", marginBottom: 5 }}>주요 리스크</div>{analysis.risks.map((r,i) => <div key={i} style={{ fontSize: 11, color: "#b0b8c8", marginBottom: 3 }}>• {r}</div>)}</div>)}
                  </div>
                )}
                {analysis.macro?.length > 0 && (
                  <div style={{ background: "#1a1d27", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#7c8599", marginBottom: 6 }}>거시 경제</div>
                    {analysis.macro.map((m,i) => <div key={i} style={{ fontSize: 11, color: "#b0b8c8", padding: "3px 0", borderBottom: i < analysis.macro.length-1 ? "1px solid #2d3040" : "none" }}>• {m}</div>)}
                  </div>
                )}
                <button onClick={runAnalysis} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #2d3040", background: "transparent", color: "#7c8599", cursor: "pointer", fontSize: 11 }}>🔄 재분석</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 종목 추가 모달 */}
      {showAdd && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={e => e.target === e.currentTarget && setShowAdd(false)}>
          <div style={{ background: "#1a1d27", borderRadius: 16, padding: 28, width: 360, border: "1px solid #2d3040" }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20 }}>📈 종목 추가</div>

            {/* 인기 종목 바로가기 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "#7c8599", marginBottom: 8 }}>인기 종목</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {POPULAR.filter(p => !stocks[p.symbol]).map(p => (
                  <button key={p.symbol} onClick={() => addStock(p.symbol)} style={{
                    padding: "4px 10px", borderRadius: 16, border: "1px solid #2d3040",
                    background: "transparent", color: "#e0e6ed", cursor: "pointer", fontSize: 12,
                  }}>{p.name}</button>
                ))}
              </div>
            </div>

            {/* 직접 입력 */}
            <div style={{ fontSize: 11, color: "#7c8599", marginBottom: 6 }}>티커 직접 입력</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={addSymbol}
                onChange={e => { setAddSymbol(e.target.value.toUpperCase()); setAddError(""); }}
                onKeyDown={e => e.key === "Enter" && addStock()}
                placeholder="예: AAPL, 000660.KS"
                style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: "1px solid #2d3040", background: "#0f1117", color: "#e0e6ed", fontSize: 13, outline: "none" }}
              />
              <button onClick={() => addStock()} disabled={addLoading} style={{
                padding: "10px 16px", borderRadius: 8, border: "none",
                background: "#3b82f6", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13,
              }}>{addLoading ? "…" : "추가"}</button>
            </div>
            {addError && <div style={{ color: "#ef4444", fontSize: 12, marginTop: 6 }}>{addError}</div>}
            <div style={{ fontSize: 11, color: "#4b5563", marginTop: 8 }}>한국: 종목코드.KS (예: 005935.KS) | 미국: 티커 (예: GOOGL)</div>

            <button onClick={() => setShowAdd(false)} style={{ width: "100%", marginTop: 16, padding: 10, borderRadius: 8, border: "1px solid #2d3040", background: "transparent", color: "#7c8599", cursor: "pointer", fontSize: 13 }}>취소</button>
          </div>
        </div>
      )}
    </div>
  );
}
