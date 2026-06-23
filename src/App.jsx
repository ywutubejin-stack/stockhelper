import { useState, useEffect, useCallback, useMemo } from "react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell
} from "recharts";

const STOCKS = {
  samsung: {
    name: "삼성전자", fullName: "삼성전자 (005930.KS)",
    symbol: "005930.KS", exchange: "KOSPI", currency: "KRW",
    base: 356000, vol: 0.025, trend: 0.001, purchase: null,
    fmt: v => v != null ? Math.round(v).toLocaleString("ko-KR") + "원" : "-",
  },
  spacex: {
    name: "SpaceX (SPCX)", fullName: "SpaceX SPCX",
    symbol: "SPCX", exchange: "NASDAQ", currency: "USD",
    base: 196, vol: 0.024, trend: -0.001, purchase: 212,
    fmt: v => v != null ? "$" + Number(v).toFixed(2) : "-",
  },
};

// ─── Supabase Edge Function URL (빌드 시 주입) ──────────────────────────────
// GitHub Secrets > VITE_ANALYZE_URL 에 설정
const ANALYZE_URL = import.meta.env.VITE_ANALYZE_URL ?? "";

// ─── YAHOO FINANCE ────────────────────────────────────────────────────────────
async function fetchYahoo(symbol) {
  const encoded = encodeURIComponent(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=6mo`
  );
  const res = await fetch(`https://corsproxy.io/?url=${encoded}`, { signal: AbortSignal.timeout(9000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error("No result");
  const q = r.indicators.quote[0];
  const meta = r.meta;
  const data = r.timestamp
    .map((t, i) => {
      const d = new Date(t * 1000);
      return { date: `${d.getMonth()+1}/${d.getDate()}`, open: q.open[i], high: q.high[i], close: q.close[i], low: q.low[i], volume: q.volume[i]||0 };
    })
    .filter(d => d.close != null && !isNaN(d.close));
  return { data, currentPrice: meta.regularMarketPrice, dayChange: meta.regularMarketChange, dayChangePct: meta.regularMarketChangePercent };
}

async function fetchIndices() {
  try {
    const [k, n] = await Promise.all([fetchYahoo("^KS11"), fetchYahoo("^IXIC")]);
    return { kospi: { value: k.currentPrice, pct: k.dayChangePct }, nasdaq: { value: n.currentPrice, pct: n.dayChangePct } };
  } catch { return null; }
}

// ─── INDICATORS ───────────────────────────────────────────────────────────────
const calcSMA = (arr, n) => arr.map((_, i) => i < n-1 ? null : arr.slice(i-n+1,i+1).reduce((a,b)=>a+b)/n);
const calcEMA = (arr, n) => { const k=2/(n+1); return arr.reduce((acc,v,i)=>{acc.push(i===0?v:v*k+acc[i-1]*(1-k));return acc;},[]);};
const calcRSI = (arr, n=14) => arr.map((_,i)=>{if(i<n)return null;let g=0,l=0;for(let j=i-n+1;j<=i;j++){const d=arr[j]-arr[j-1];d>0?(g+=d):(l-=d);}return +(100-100/(1+g/(l||1e-9))).toFixed(2);});
const calcBB = (arr, n=20) => { const m=calcSMA(arr,n); return arr.map((_,i)=>{if(!m[i])return{};const std=Math.sqrt(arr.slice(i-n+1,i+1).reduce((a,v)=>a+(v-m[i])**2,0)/n);return{u:m[i]+2*std,mid:m[i],lo:m[i]-2*std};});};
const calcMACD = arr => { const e12=calcEMA(arr,12),e26=calcEMA(arr,26),line=e12.map((v,i)=>v-e26[i]),sig=calcEMA(line,9);return{line,sig,hist:line.map((v,i)=>v-sig[i])};};

function genOHLCV(stock, days=130) {
  const result=[]; let p=stock.base; const start=new Date(); start.setDate(start.getDate()-days-10); let trend=stock.trend;
  for(let i=0;i<days+20;i++){const d=new Date(start);d.setDate(d.getDate()+i);if([0,6].includes(d.getDay()))continue;if(i===30)trend=-trend;if(i===70)trend=stock.trend;const chg=trend+(Math.random()-0.5)*stock.vol+Math.sin(i*0.18)*stock.vol*0.3;const o=p,c=p*(1+chg);result.push({date:`${d.getMonth()+1}/${d.getDate()}`,open:o,high:Math.max(o,c)*(1+Math.random()*stock.vol*0.25),close:c,low:Math.min(o,c)*(1-Math.random()*stock.vol*0.25),volume:Math.floor(Math.random()*12e6+3e6)});p=c;}
  return result.slice(-days);
}

function buildChart(raw, stock) {
  const closes=raw.map(d=>d.close),s20=calcSMA(closes,20),s60=calcSMA(closes,60),rsi=calcRSI(closes),{line:ml,sig:ms,hist:mh}=calcMACD(closes),bands=calcBB(closes),dp=stock.currency==="KRW"?0:2,fx=v=>(v==null||isNaN(v))?null:+v.toFixed(dp);
  return raw.map((d,i)=>({date:d.date,open:fx(d.open),high:fx(d.high),close:fx(d.close),low:fx(d.low),volume:d.volume,ma20:fx(s20[i]),ma60:fx(s60[i]),bbU:fx(bands[i]?.u),bbM:fx(bands[i]?.mid),bbL:fx(bands[i]?.lo),rsi:rsi[i],macd:fx(ml[i]),macdSig:fx(ms[i]),macdH:fx(mh[i])}));
}

function computeSignals(cd) {
  const l=cd[cd.length-1],p=cd[cd.length-2];if(!l||!p)return{signals:[],bullPct:50};
  const S=[],add=(type,label,detail,w)=>S.push({type,label,detail,w});
  if(l.rsi!=null){if(l.rsi<30)add("buy","RSI 과매도",`RSI ${l.rsi}`,3);else if(l.rsi>70)add("sell","RSI 과매수",`RSI ${l.rsi}`,3);else if(l.rsi<45)add("sell","RSI 약세",`RSI ${l.rsi}`,1);else add("buy","RSI 강세",`RSI ${l.rsi}`,1);}
  if(l.ma20&&l.ma60){if(l.ma20>l.ma60&&p.ma20<=p.ma60)add("buy","골든크로스!","MA20 상향돌파",5);else if(l.ma20<l.ma60&&p.ma20>=p.ma60)add("sell","데드크로스!","MA20 하향돌파",5);else if(l.ma20>l.ma60)add("buy","MA 정배열","MA20>MA60",1);else add("sell","MA 역배열","MA20<MA60",1);}
  if(l.macd!=null){if(l.macd>l.macdSig&&p.macd<=p.macdSig)add("buy","MACD 골든크로스","MACD↑Signal",3);else if(l.macd<l.macdSig&&p.macd>=p.macdSig)add("sell","MACD 데드크로스","MACD↓Signal",3);else if(l.macd>l.macdSig)add("buy","MACD 매수","MACD>Signal",1);else add("sell","MACD 매도","MACD<Signal",1);}
  if(l.bbU&&l.bbL){const pos=(l.close-l.bbL)/(l.bbU-l.bbL);if(l.close<l.bbL)add("buy","BB 하단 이탈",`${(pos*100).toFixed(0)}%`,2);else if(l.close>l.bbU)add("sell","BB 상단 돌파",`${(pos*100).toFixed(0)}%`,2);else if(pos<0.3)add("buy","BB 하단권",`${(pos*100).toFixed(0)}%`,1);else if(pos>0.7)add("sell","BB 상단권",`${(pos*100).toFixed(0)}%`,1);else add("neutral","BB 중립권",`${(pos*100).toFixed(0)}%`,0);}
  if(l.ma20){const pct=((l.close-l.ma20)/l.ma20*100).toFixed(1);if(l.close>l.ma20)add("buy","MA20 상단",`+${pct}%`,1);else add("sell","MA20 하단",`${pct}%`,1);}
  const bW=S.filter(s=>s.type==="buy").reduce((a,s)=>a+s.w,0),sW=S.filter(s=>s.type==="sell").reduce((a,s)=>a+s.w,0);
  return{signals:S,bullPct:bW+sW>0?Math.round(bW/(bW+sW)*100):50};
}

function PriceTip({active,payload,label,fmt}){if(!active||!payload?.length)return null;const d=payload[0]?.payload;return(<div style={{background:"#1a1d27",border:"1px solid #2d3040",borderRadius:8,padding:"10px 14px",fontSize:11,color:"#e0e6ed",lineHeight:1.9}}><div style={{color:"#7c8599",fontWeight:600,marginBottom:2}}>{label}</div>{d.close!=null&&<div>종가 <b style={{color:"#fff"}}>{fmt(d.close)}</b></div>}{d.ma20!=null&&<div>MA20 <span style={{color:"#fbbf24"}}>{fmt(d.ma20)}</span></div>}{d.ma60!=null&&<div>MA60 <span style={{color:"#a78bfa"}}>{fmt(d.ma60)}</span></div>}{d.bbU!=null&&<div>BB상단 <span style={{color:"#38bdf8"}}>{fmt(d.bbU)}</span></div>}{d.bbL!=null&&<div>BB하단 <span style={{color:"#38bdf8"}}>{fmt(d.bbL)}</span></div>}</div>);}

function IdxBadge({label,value,pct}){if(value==null)return<span style={{color:"#4b5563",fontSize:12}}>{label} —</span>;const up=pct>=0;return(<span style={{fontSize:12}}><span style={{color:"#7c8599"}}>{label} </span><span style={{color:up?"#22c55e":"#ef4444",fontWeight:600}}>{value.toLocaleString("ko-KR",{maximumFractionDigits:0})} {up?"▲":"▼"}{Math.abs(pct).toFixed(2)}%</span></span>);}

export default function App() {
  const [sel,setSel]=useState("samsung");
  const [range,setRange]=useState(66);
  const [chart,setChart]=useState([]);
  const [sigs,setSigs]=useState(null);
  const [analysis,setAnalysis]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);
  const [dataStatus,setDataStatus]=useState("loading");
  const [indices,setIndices]=useState(null);
  const [apiMeta,setApiMeta]=useState(null);

  const stock=STOCKS[sel];

  useEffect(()=>{
    setAnalysis(null);setSigs(null);setChart([]);setDataStatus("loading");setApiMeta(null);
    const load=async()=>{
      try{const result=await fetchYahoo(stock.symbol);const cd=buildChart(result.data,stock);setChart(cd);setSigs(computeSignals(cd));setApiMeta({currentPrice:result.currentPrice,dayChange:result.dayChange,dayChangePct:result.dayChangePct});setDataStatus("real");}
      catch{const raw=genOHLCV(stock,130);const cd=buildChart(raw,stock);setChart(cd);setSigs(computeSignals(cd));setDataStatus("mock");}
    };
    load();
  },[sel]);

  useEffect(()=>{fetchIndices().then(setIndices);},[]);

  const display=useMemo(()=>chart.slice(-range),[chart,range]);
  const ticks=useMemo(()=>{if(!display.length)return[];const step=Math.max(1,Math.floor(display.length/6));return display.filter((_,i)=>i%step===0).map(d=>d.date);},[display]);

  const l=chart[chart.length-1];
  const currentPrice=dataStatus==="real"&&apiMeta?apiMeta.currentPrice:l?.close;
  const dayChgPct=dataStatus==="real"&&apiMeta?apiMeta.dayChangePct:(l&&chart[chart.length-2]?(l.close-chart[chart.length-2].close)/chart[chart.length-2].close*100:0);
  const dayChgAbs=dataStatus==="real"&&apiMeta?apiMeta.dayChange:(l&&chart[chart.length-2]?l.close-chart[chart.length-2].close:0);

  const runAnalysis=useCallback(async()=>{
    if(!l||!sigs)return;
    setAiLoading(true);setAnalysis(null);
    try{
      if(!ANALYZE_URL){throw new Error("VITE_ANALYZE_URL이 설정되지 않았습니다. GitHub Secrets를 확인하세요.");}
      const systemPrompt=`당신은 전문 주식 애널리스트입니다. 구글 검색으로 최신 정보를 수집하고 한국어로 분석해주세요.\n반드시 아래 JSON만 반환 (마크다운 없이, 코드블록 없이):\n{"news":[{"title":"...","sentiment":"positive|negative|neutral","impact":"..."}],"macro":["..."],"risks":["..."],"catalysts":["..."],"recommendation":"BUY|SELL|HOLD","targetPrice":"...","confidence":75,"reasoning":"..."}`;
      const prompt=`${stock.fullName} 분석. 현재가: ${stock.fmt(currentPrice)} | 전일비: ${dayChgPct>=0?"+":""}${dayChgPct.toFixed(2)}%${stock.purchase?` | 매수가: ${stock.fmt(stock.purchase)} (${((currentPrice/stock.purchase-1)*100).toFixed(1)}%)`:""}. RSI: ${l.rsi} | 매수신호: ${sigs.bullPct}%. 최신 뉴스, 거시 동향, 매수/매도/관망 의견.`;
      const res=await fetch(ANALYZE_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt,systemPrompt})});
      const {text,error}=await res.json();
      if(error)throw new Error(error);
      try{setAnalysis(JSON.parse(text.replace(/```json|```/g,"").trim()));}
      catch{setAnalysis({error:true,reasoning:text||"파싱 오류",recommendation:"HOLD",news:[],macro:[],risks:[],catalysts:[],confidence:50});}
    }catch(err){setAnalysis({error:true,reasoning:err.message,recommendation:"HOLD",news:[],macro:[],risks:[],catalysts:[],confidence:50});}
    finally{setAiLoading(false);}
  },[l,sigs,stock,currentPrice,dayChgPct]);

  const sigLabel=!sigs?"—":sigs.bullPct>=65?"강한 매수":sigs.bullPct>=55?"매수 우세":sigs.bullPct>=45?"중립":sigs.bullPct>=35?"매도 우세":"강한 매도";
  const sigColor=!sigs?"#7c8599":sigs.bullPct>=60?"#22c55e":sigs.bullPct<=40?"#ef4444":"#f59e0b";
  const recColor=!analysis?"#7c8599":analysis.recommendation==="BUY"?"#22c55e":analysis.recommendation==="SELL"?"#ef4444":"#f59e0b";
  const card={background:"#1a1d27",borderRadius:10,border:"1px solid #2d3040",padding:"12px 14px"};
  const yfmt=v=>stock.currency==="KRW"?(v/1000).toFixed(0)+"k":"$"+Number(v).toFixed(0);

  return(
    <div style={{background:"#0f1117",color:"#e0e6ed",fontFamily:"system-ui,-apple-system,sans-serif",display:"flex",flexDirection:"column",height:"100vh"}}>
      <div style={{background:"#13161f",borderBottom:"1px solid #2d3040",padding:"10px 16px",display:"flex",alignItems:"center",gap:16,flexWrap:"wrap",flexShrink:0}}>
        <div style={{fontWeight:700,fontSize:14,color:"#3b82f6"}}>📊 StockAnalyst</div>
        <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
          <IdxBadge label="KOSPI" value={indices?.kospi?.value} pct={indices?.kospi?.pct}/>
          <IdxBadge label="NASDAQ" value={indices?.nasdaq?.value} pct={indices?.nasdaq?.pct}/>
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          {Object.entries(STOCKS).map(([k,s])=>(
            <button key={k} onClick={()=>setSel(k)} style={{padding:"5px 14px",borderRadius:20,border:`1px solid ${sel===k?"#3b82f6":"#2d3040"}`,background:sel===k?"rgba(59,130,246,0.15)":"transparent",color:sel===k?"#3b82f6":"#7c8599",cursor:"pointer",fontSize:12,fontWeight:sel===k?600:400}}>{s.name}</button>
          ))}
        </div>
      </div>

      <div style={{background:"#13161f",padding:"8px 16px",borderBottom:"1px solid #2d3040",display:"flex",alignItems:"center",gap:14,flexWrap:"wrap",flexShrink:0,minHeight:48}}>
        {dataStatus==="loading"?<span style={{color:"#7c8599",fontSize:13}}>📡 Yahoo Finance 수신 중…</span>:currentPrice?(
          <>
            <span style={{fontSize:11,color:"#7c8599"}}>{stock.fullName}</span>
            <span style={{fontSize:22,fontWeight:700}}>{stock.fmt(currentPrice)}</span>
            <span style={{color:dayChgPct>=0?"#22c55e":"#ef4444",fontWeight:600,fontSize:13}}>
              {dayChgPct>=0?"▲":"▼"} {stock.currency==="KRW"?Math.abs(Math.round(dayChgAbs)).toLocaleString("ko-KR"):Math.abs(dayChgAbs).toFixed(2)} ({Math.abs(dayChgPct).toFixed(2)}%)
            </span>
            {stock.purchase&&currentPrice&&(<span style={{fontSize:12,color:"#7c8599"}}>매수가 {stock.fmt(stock.purchase)} | <span style={{color:currentPrice>=stock.purchase?"#22c55e":"#ef4444",fontWeight:600}}>{((currentPrice/stock.purchase-1)*100).toFixed(1)}% {currentPrice>=stock.purchase?"이익":"손실"}</span></span>)}
            <div style={{marginLeft:"auto",display:"flex",gap:6,alignItems:"center"}}>
              <span style={{fontSize:10,padding:"2px 8px",borderRadius:10,background:dataStatus==="real"?"rgba(34,197,94,0.1)":"rgba(245,158,11,0.1)",color:dataStatus==="real"?"#22c55e":"#f59e0b",border:`1px solid ${dataStatus==="real"?"rgba(34,197,94,0.3)":"rgba(245,158,11,0.3)"}`}}>{dataStatus==="real"?"● 실시간":"● 시뮬레이션"}</span>
              {[[22,"1개월"],[66,"3개월"],[130,"6개월"]].map(([r,label])=>(
                <button key={r} onClick={()=>setRange(r)} style={{padding:"3px 10px",borderRadius:6,border:`1px solid ${range===r?"#3b82f6":"#2d3040"}`,background:range===r?"rgba(59,130,246,0.1)":"transparent",color:range===r?"#3b82f6":"#7c8599",cursor:"pointer",fontSize:11}}>{label}</button>
              ))}
            </div>
          </>
        ):<span style={{color:"#ef4444",fontSize:12}}>API 연결 실패 — 시뮬레이션 표시 중</span>}
      </div>

      <div style={{flex:1,display:"grid",gridTemplateColumns:"1fr 300px",overflow:"hidden"}}>
        <div style={{overflowY:"auto",padding:"12px 10px 12px 14px",display:"flex",flexDirection:"column",gap:10}}>
          {dataStatus==="loading"&&(<div style={{display:"flex",alignItems:"center",justifyContent:"center",flex:1,flexDirection:"column",gap:12,color:"#7c8599",paddingTop:80}}><div style={{fontSize:36}}>📡</div><div style={{fontSize:14}}>Yahoo Finance 연결 중…</div></div>)}
          {dataStatus!=="loading"&&(<>
            <div style={card}>
              <div style={{fontSize:12,color:"#7c8599",marginBottom:8,display:"flex",gap:14,alignItems:"center",flexWrap:"wrap"}}>
                <span style={{fontWeight:600,color:"#e0e6ed"}}>가격 차트</span>
                {[["#3b82f6","종가"],["#fbbf24","MA20"],["#a78bfa","MA60"],["#38bdf8","BB"]].map(([c,label])=>(<span key={label} style={{display:"flex",alignItems:"center",gap:5}}><span style={{display:"inline-block",width:18,height:2,background:c}}/>{label}</span>))}
              </div>
              <ResponsiveContainer width="100%" height={195}>
                <ComposedChart data={display} margin={{top:5,right:5,bottom:5,left:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040"/>
                  <XAxis dataKey="date" ticks={ticks} tick={{fill:"#7c8599",fontSize:10}}/>
                  <YAxis domain={["auto","auto"]} tick={{fill:"#7c8599",fontSize:10}} width={52} tickFormatter={yfmt}/>
                  <Tooltip content={<PriceTip fmt={stock.fmt}/>}/>
                  <Line type="monotone" dataKey="bbU" stroke="#38bdf8" strokeWidth={1} dot={false} opacity={0.55}/>
                  <Line type="monotone" dataKey="bbM" stroke="#38bdf8" strokeWidth={0.8} dot={false} opacity={0.3} strokeDasharray="4 3"/>
                  <Line type="monotone" dataKey="bbL" stroke="#38bdf8" strokeWidth={1} dot={false} opacity={0.55}/>
                  <Line type="monotone" dataKey="close" stroke="#3b82f6" strokeWidth={2} dot={false}/>
                  <Line type="monotone" dataKey="ma20" stroke="#fbbf24" strokeWidth={1.5} dot={false} strokeDasharray="5 2"/>
                  <Line type="monotone" dataKey="ma60" stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="5 2"/>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{...card,padding:"10px 14px"}}>
              <div style={{fontSize:11,fontWeight:600,color:"#7c8599",marginBottom:6}}>거래량</div>
              <ResponsiveContainer width="100%" height={68}>
                <ComposedChart data={display} margin={{top:0,right:5,bottom:0,left:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040"/>
                  <XAxis dataKey="date" ticks={ticks} tick={{fill:"#7c8599",fontSize:9}}/>
                  <YAxis tick={{fill:"#7c8599",fontSize:9}} width={44} tickFormatter={v=>(v/1e6).toFixed(0)+"M"}/>
                  <Bar dataKey="volume" radius={[2,2,0,0]}>{display.map((d,i)=><Cell key={i} fill={i===0||d.close>=(display[i-1]?.close??d.close)?"rgba(34,197,94,0.5)":"rgba(239,68,68,0.5)"}/>)}</Bar>
                  <Tooltip contentStyle={{background:"#1a1d27",border:"1px solid #2d3040",color:"#e0e6ed",fontSize:11}} formatter={v=>[(v/1e6).toFixed(2)+"M","거래량"]}/>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{...card,padding:"10px 14px"}}>
              <div style={{fontSize:11,fontWeight:600,marginBottom:6,display:"flex",gap:10,alignItems:"center"}}>
                <span style={{color:"#e0e6ed"}}>RSI (14)</span>
                {l?.rsi!=null&&<span style={{color:l.rsi<30?"#22c55e":l.rsi>70?"#ef4444":"#f59e0b",fontSize:13,fontWeight:700}}>{l.rsi}<span style={{fontSize:10,fontWeight:400,color:"#7c8599",marginLeft:5}}>{l.rsi<30?"과매도":l.rsi>70?"과매수":"중립"}</span></span>}
              </div>
              <ResponsiveContainer width="100%" height={88}>
                <ComposedChart data={display} margin={{top:5,right:5,bottom:5,left:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040"/>
                  <XAxis dataKey="date" ticks={ticks} tick={{fill:"#7c8599",fontSize:9}}/>
                  <YAxis domain={[0,100]} ticks={[30,50,70]} tick={{fill:"#7c8599",fontSize:9}} width={24}/>
                  <ReferenceLine y={70} stroke="#ef4444" strokeDasharray="4 3" strokeOpacity={0.5}/>
                  <ReferenceLine y={30} stroke="#22c55e" strokeDasharray="4 3" strokeOpacity={0.5}/>
                  <ReferenceLine y={50} stroke="#2d3040"/>
                  <Line type="monotone" dataKey="rsi" stroke="#f59e0b" strokeWidth={2} dot={false}/>
                  <Tooltip contentStyle={{background:"#1a1d27",border:"1px solid #2d3040",color:"#e0e6ed",fontSize:11}} formatter={v=>[v?.toFixed(1),"RSI"]}/>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{...card,padding:"10px 14px"}}>
              <div style={{fontSize:11,fontWeight:600,marginBottom:6,display:"flex",gap:14,alignItems:"center"}}>
                <span style={{color:"#e0e6ed"}}>MACD (12, 26, 9)</span>
                {[["#3b82f6","MACD"],["#f97316","Signal"]].map(([c,label])=>(<span key={label} style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"#7c8599"}}><span style={{display:"inline-block",width:14,height:2,background:c}}/>{label}</span>))}
              </div>
              <ResponsiveContainer width="100%" height={88}>
                <ComposedChart data={display} margin={{top:5,right:5,bottom:5,left:0}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2d3040"/>
                  <XAxis dataKey="date" ticks={ticks} tick={{fill:"#7c8599",fontSize:9}}/>
                  <YAxis tick={{fill:"#7c8599",fontSize:9}} width={40}/>
                  <ReferenceLine y={0} stroke="#3d4660"/>
                  <Bar dataKey="macdH" radius={[1,1,0,0]}>{display.map((d,i)=><Cell key={i} fill={d.macdH>=0?"rgba(34,197,94,0.55)":"rgba(239,68,68,0.55)"}/>)}</Bar>
                  <Line type="monotone" dataKey="macd" stroke="#3b82f6" strokeWidth={1.5} dot={false}/>
                  <Line type="monotone" dataKey="macdSig" stroke="#f97316" strokeWidth={1.5} dot={false}/>
                  <Tooltip contentStyle={{background:"#1a1d27",border:"1px solid #2d3040",color:"#e0e6ed",fontSize:11}}/>
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </>)}
        </div>

        <div style={{borderLeft:"1px solid #2d3040",background:"#13161f",overflowY:"auto"}}>
          {sigs&&dataStatus!=="loading"&&(
            <div style={{padding:14,borderBottom:"1px solid #2d3040"}}>
              <div style={{fontSize:10,fontWeight:600,color:"#4b5563",letterSpacing:0.8,textTransform:"uppercase",marginBottom:10}}>기술적 분석</div>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
                <span style={{color:"#22c55e",fontWeight:600}}>매수 {sigs.bullPct}%</span>
                <span style={{color:sigColor,fontWeight:700}}>{sigLabel}</span>
                <span style={{color:"#ef4444",fontWeight:600}}>매도 {100-sigs.bullPct}%</span>
              </div>
              <div style={{height:7,background:"#2d3040",borderRadius:4,overflow:"hidden",marginBottom:12}}>
                <div style={{width:`${sigs.bullPct}%`,height:"100%",background:sigColor,borderRadius:4,transition:"width 0.6s ease"}}/>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {sigs.signals.map((s,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:11,padding:"4px 6px",borderRadius:5,background:"rgba(255,255,255,0.02)"}}>
                    <span style={{color:s.type==="buy"?"#22c55e":s.type==="sell"?"#ef4444":"#4b5563",fontSize:9,flexShrink:0}}>{s.type==="buy"?"▲":s.type==="sell"?"▼":"●"}</span>
                    <span style={{flex:1,color:s.type==="neutral"?"#7c8599":"#e0e6ed"}}>{s.label}</span>
                    <span style={{color:"#4b5563",fontSize:10}}>{s.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {l&&dataStatus!=="loading"&&(
            <div style={{padding:14,borderBottom:"1px solid #2d3040"}}>
              <div style={{fontSize:10,fontWeight:600,color:"#4b5563",letterSpacing:0.8,textTransform:"uppercase",marginBottom:10}}>주요 지표</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[{label:"현재가",value:stock.fmt(currentPrice)},{label:"전일비",value:`${dayChgPct>=0?"+":""}${dayChgPct.toFixed(2)}%`,color:dayChgPct>=0?"#22c55e":"#ef4444"},{label:"MA 20",value:stock.fmt(l.ma20)},{label:"MA 60",value:stock.fmt(l.ma60)},{label:"RSI",value:l.rsi?.toFixed(1)??"—",color:l.rsi<30?"#22c55e":l.rsi>70?"#ef4444":"#e0e6ed"},{label:"MACD",value:l.macd!=null?(stock.currency==="KRW"?Math.round(l.macd).toLocaleString():l.macd.toFixed(3)):"—",color:l.macd>l.macdSig?"#22c55e":"#ef4444"},{label:"BB 상단",value:stock.fmt(l.bbU)},{label:"BB 하단",value:stock.fmt(l.bbL)}].map(({label,value,color})=>(
                  <div key={label} style={{background:"#1a1d27",borderRadius:6,padding:"7px 9px"}}>
                    <div style={{fontSize:9,color:"#4b5563",marginBottom:2}}>{label}</div>
                    <div style={{fontSize:11,fontWeight:600,color:color||"#e0e6ed",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div style={{padding:14}}>
            <div style={{fontSize:10,fontWeight:600,color:"#4b5563",letterSpacing:0.8,textTransform:"uppercase",marginBottom:10}}>Gemini AI 분석</div>
            {!analysis&&!aiLoading&&dataStatus!=="loading"&&(
              <button onClick={runAnalysis} style={{width:"100%",padding:11,borderRadius:8,border:"1px solid #3b82f6",background:"rgba(59,130,246,0.08)",color:"#3b82f6",cursor:"pointer",fontWeight:600,fontSize:13}}>✨ Gemini 분석 시작</button>
            )}
            {aiLoading&&(<div style={{textAlign:"center",padding:"22px 0",color:"#7c8599"}}><div style={{fontSize:26,marginBottom:8}}>⏳</div><div style={{fontSize:13}}>Gemini가 구글 검색 중…</div></div>)}
            {analysis&&(
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                <div style={{background:`rgba(${analysis.recommendation==="BUY"?"34,197,94":analysis.recommendation==="SELL"?"239,68,68":"245,158,11"},0.07)`,border:`1px solid ${recColor}35`,borderRadius:10,padding:"12px 14px"}}>
                  <div style={{fontSize:17,fontWeight:700,color:recColor,textAlign:"center"}}>{analysis.recommendation==="BUY"?"🟢 매수 (BUY)":analysis.recommendation==="SELL"?"🔴 매도 (SELL)":"🟡 관망 (HOLD)"}</div>
                  <div style={{display:"flex",justifyContent:"center",gap:10,marginTop:5,fontSize:11,color:"#7c8599"}}>
                    {analysis.confidence&&<span>신뢰도 {analysis.confidence}%</span>}
                    {analysis.targetPrice&&<span>목표가 <b style={{color:recColor}}>{analysis.targetPrice}</b></span>}
                  </div>
                  {analysis.reasoning&&<div style={{fontSize:12,color:"#b0b8c8",marginTop:8,lineHeight:1.7}}>{analysis.reasoning}</div>}
                </div>
                {analysis.news?.length>0&&(<div><div style={{fontSize:11,fontWeight:600,color:"#7c8599",marginBottom:6}}>최신 뉴스</div>{analysis.news.map((n,i)=>(<div key={i} style={{background:"#1a1d27",borderRadius:6,padding:"7px 9px",marginBottom:5}}><div style={{display:"flex",gap:6,alignItems:"flex-start"}}><span style={{color:n.sentiment==="positive"?"#22c55e":n.sentiment==="negative"?"#ef4444":"#f59e0b",flexShrink:0,fontSize:10,marginTop:1}}>{n.sentiment==="positive"?"▲":n.sentiment==="negative"?"▼":"●"}</span><div><div style={{fontSize:12,fontWeight:500,lineHeight:1.5}}>{n.title}</div>{n.impact&&<div style={{fontSize:11,color:"#7c8599",marginTop:2}}>{n.impact}</div>}</div></div></div>))}</div>)}
                {(analysis.catalysts?.length>0||analysis.risks?.length>0)&&(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>{analysis.catalysts?.length>0&&(<div style={{background:"rgba(34,197,94,0.05)",border:"1px solid rgba(34,197,94,0.15)",borderRadius:8,padding:"8px 10px"}}><div style={{fontSize:11,fontWeight:600,color:"#22c55e",marginBottom:5}}>상승 촉매</div>{analysis.catalysts.map((c,i)=><div key={i} style={{fontSize:11,color:"#b0b8c8",marginBottom:3}}>• {c}</div>)}</div>)}{analysis.risks?.length>0&&(<div style={{background:"rgba(239,68,68,0.05)",border:"1px solid rgba(239,68,68,0.15)",borderRadius:8,padding:"8px 10px"}}><div style={{fontSize:11,fontWeight:600,color:"#ef4444",marginBottom:5}}>주요 리스크</div>{analysis.risks.map((r,i)=><div key={i} style={{fontSize:11,color:"#b0b8c8",marginBottom:3}}>• {r}</div>)}</div>)}</div>)}
                {analysis.macro?.length>0&&(<div style={{background:"#1a1d27",borderRadius:8,padding:"8px 10px"}}><div style={{fontSize:11,fontWeight:600,color:"#7c8599",marginBottom:6}}>거시 경제</div>{analysis.macro.map((m,i)=><div key={i} style={{fontSize:11,color:"#b0b8c8",padding:"3px 0",borderBottom:i<analysis.macro.length-1?"1px solid #2d3040":"none"}}>• {m}</div>)}</div>)}
                <button onClick={runAnalysis} style={{width:"100%",padding:8,borderRadius:6,border:"1px solid #2d3040",background:"transparent",color:"#7c8599",cursor:"pointer",fontSize:11}}>🔄 재분석</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

