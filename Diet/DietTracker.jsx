import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";

// ─────────────────────────────────────────────────────────────
// サーバ同期の設定（Worker デプロイ後に実値を埋める）
//   - PROXY_URL     : Cloudflare Worker の公開URL
//   - SHARED_SECRET : Worker に登録した SHARED_SECRET と同じ合言葉
//   - DATA_URL      : 正本 data/diet.json の公開（raw）URL
// 未設定（プレースホルダ）のままなら同期は自動でスキップし、v2 と同じローカル動作になる。
// ※ GitHubトークンはアプリに置かない。書き込みは必ず Worker 経由。
// ─────────────────────────────────────────────────────────────
const PROXY_URL     = "https://xxxx.workers.dev";
const SHARED_SECRET = "（合言葉）";
const DATA_URL      = "https://raw.githubusercontent.com/<owner>/<repo>/main/data/diet.json";

const isPlaceholder = (s) => !s || /xxxx|（|＜|<owner>|<repo>/.test(s);
const SYNC_ENABLED     = !isPlaceholder(PROXY_URL) && !isPlaceholder(SHARED_SECRET);
const READBACK_ENABLED = !isPlaceholder(DATA_URL);
const genId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

const CAL_TARGET = 1800;
const W_START = 80;
const W_GOAL_DEFAULT = 69;
const BMR = 1800;            // 基礎代謝 + 非運動アクティブ（安静時1650 + 約170）
const KCAL_PER_STEP = 0.04;

const EXERCISES = [
  { id:"squat",  cat:"筋トレ", label:"スクワット",        vol:"15回 × 3セット",      kcal:50  },
  { id:"push",   cat:"筋トレ", label:"プッシュアップ",      vol:"10回 × 3セット",      kcal:40  },
  { id:"plank",  cat:"筋トレ", label:"プランク",          vol:"30秒 × 3セット",      kcal:20  },
  { id:"lunge",  cat:"筋トレ", label:"ランジ",            vol:"左右各10回 × 3セット",  kcal:45  },
  { id:"hip",    cat:"筋トレ", label:"ヒップリフト",        vol:"15回 × 3セット",      kcal:30  },
  { id:"crunch", cat:"筋トレ", label:"クランチ（腹筋）",     vol:"15回 × 3セット",      kcal:35  },
  { id:"jog",    cat:"有酸素", label:"早歩き / ジョギング",  vol:"20分",              kcal:150 },
  { id:"stair",  cat:"有酸素", label:"階段昇降",          vol:"10分",              kcal:90  },
  { id:"rope",   cat:"有酸素", label:"縄跳び",            vol:"10分",              kcal:130 },
  { id:"stretch",cat:"柔軟",   label:"ストレッチ",          vol:"10分",              kcal:30  },
];
const CATS = ["筋トレ", "有酸素", "柔軟"];

const getToday = () => new Date().toISOString().split("T")[0];
const fmtDate  = (s) => { const d = new Date(s + "T00:00:00"); return `${d.getMonth()+1}/${d.getDate()}`; };
const fmtYM    = (s) => { const d = new Date(s + "T00:00:00"); return `${String(d.getFullYear()).slice(2)}/${d.getMonth()+1}`; };
const sget = async (k) => { try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; } };
const sset = async (k, v) => { try { await window.storage.set(k, JSON.stringify(v)); } catch {} };
const sortByDate = (a) => [...a].sort((x,y)=>x.d.localeCompare(y.d));

const RANGES = [
  { key:"21d", label:"3週間", days:21  },
  { key:"3m",  label:"3ヶ月", days:90  },
  { key:"1y",  label:"1年",   days:365 },
  { key:"all", label:"全期間", days:null },
];
const rangeCutoff = (days) => { if (days===null) return null; const d=new Date(); d.setDate(d.getDate()-(days-1)); return d.toISOString().split("T")[0]; };

// ── entries(日付キー) → 内部配列 への変換（読み戻し時）──
const entriesToInternal = (data) => {
  const wl=[], cl=[], sl=[], el=[];
  const entries = data?.entries || {};
  for (const d of Object.keys(entries)) {
    const e = entries[d] || {};
    if (typeof e.w === "number") wl.push({ d, w:e.w });
    const items = Array.isArray(e.items) ? e.items : [];
    if (typeof e.c === "number" || items.length) {
      const c = typeof e.c === "number" ? e.c : items.reduce((s,x)=>s+(x.kcal||0),0);
      cl.push({ d, c, items, food: items.map(i=>i.name).join(", ") });
    }
    if (typeof e.s === "number") sl.push({ d, s:e.s });
    if (Array.isArray(e.types) && e.types.length) el.push({ d, types:e.types });
  }
  return {
    wl: sortByDate(wl), cl: sortByDate(cl), sl: sortByDate(sl), el: sortByDate(el),
    goal: (typeof data?.goal === "number" && data.goal>=30 && data.goal<=200) ? data.goal : null,
  };
};

// ── 未送信キューの差分を内部配列に再適用（読み戻しでローカル編集を失わないため）──
//    内部配列 ↔ entries の相互変換の「内部側へ畳み込む」部分。worker のマージ仕様と一致させる。
const foldDelta = (a, delta) => {
  const d = delta.date;
  let { wl, cl, sl, el, goal } = a;
  if (typeof delta.weight === "number") wl = sortByDate([...wl.filter(x=>x.d!==d), { d, w:delta.weight }]);
  if (typeof delta.steps === "number")  sl = sortByDate([...sl.filter(x=>x.d!==d), { d, s:delta.steps }]);
  if (Array.isArray(delta.exercises)) {                      // worker と同じく置換
    el = sortByDate([...el.filter(x=>x.d!==d), ...(delta.exercises.length ? [{ d, types:Array.from(new Set(delta.exercises)) }] : [])]);
  }
  if (delta.food && Array.isArray(delta.food.items) && delta.food.items.length) {  // id重複を弾いて追加
    const prev = cl.find(x=>x.d===d);
    const existing = prev?.items ?? [];
    const ids = new Set(existing.map(i=>i.id).filter(Boolean));
    const add = delta.food.items.filter(i=>!i.id || !ids.has(i.id));
    const items = [...existing, ...add];
    cl = sortByDate([...cl.filter(x=>x.d!==d), { d, c:items.reduce((s,x)=>s+(x.kcal||0),0), items, food:items.map(i=>i.name).join(", ") }]);
  } else if (typeof delta.calories === "number") {           // 合計の直接指定
    const prev = cl.find(x=>x.d===d);
    cl = sortByDate([...cl.filter(x=>x.d!==d), { d, c:delta.calories, items:prev?.items??[], food:prev?.food??"" }]);
  }
  if (typeof delta.goal === "number") goal = delta.goal;
  return { wl, cl, sl, el, goal };
};

const C = {
  bg:"#07101a", card:"#0c1824", border:"#13263a",
  accent:"#4ecca3", accentBg:"#0c2820",
  warn:"#ffb347", danger:"#ff6060", blue:"#5aa9e6",
  text:"#e4f0f8", mid:"#5a8499", dim:"#1e3448",
};
const F_SYNE = "'Syne',sans-serif";
const F_MONO = "'DM Mono',monospace";
const cardS = { background:C.card, border:`1px solid ${C.border}`, borderRadius:12, padding:16, marginBottom:12 };
const labelS = { fontSize:10, letterSpacing:3, color:C.mid, fontFamily:F_SYNE, fontWeight:600 };
const inputS = { flex:1, background:"#07101a", border:`1px solid ${C.border}`, borderRadius:8, padding:"11px 14px", color:C.text, fontSize:20, fontFamily:F_MONO, textAlign:"center" };
const btnS = { background:C.accent, color:"#051a0f", border:"none", borderRadius:8, padding:"11px 18px", fontSize:12, fontFamily:F_SYNE, fontWeight:700, letterSpacing:1 };
const chip = (done) => ({ padding:"6px 12px", borderRadius:20, fontSize:11, background:done?C.accentBg:"#070e18", border:`1px solid ${done?C.accent:C.border}`, color:done?C.accent:C.mid });

export default function DietTracker() {
  const [tab, setTab]     = useState("today");
  const [wLogs, setWLogs] = useState([]);
  const [cLogs, setCLogs] = useState([]); // {d,c,food,items}
  const [sLogs, setSLogs] = useState([]);
  const [eLogs, setELogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [inputW, setInputW] = useState("");
  const [inputC, setInputC] = useState("");
  const [inputS_, setInputS_] = useState("");
  const [toast, setToast] = useState("");
  const [goal, setGoal] = useState(W_GOAL_DEFAULT);
  const [inputGoal, setInputGoal] = useState(String(W_GOAL_DEFAULT));
  const [wRange, setWRange] = useState("21d");

  // ── サーバ同期の状態 ──
  const [online, setOnline]   = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  const [queue, setQueue]     = useState([]);   // 未送信の差分（{qid,date,...}）
  const [syncing, setSyncing] = useState(false);
  const queueRef   = useRef([]);
  const syncingRef = useRef(false);

  // universal NL input
  const [nlText, setNlText] = useState("");
  const [nlBusy, setNlBusy] = useState(false);
  const [nlResult, setNlResult] = useState("");
  const [nlError, setNlError] = useState("");
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const textareaRef = useRef(null);

  // ── 未送信キューを順番にWorkerへ送る（成功した分だけ先頭から外す）──
  const flush = useCallback(async () => {
    if (!SYNC_ENABLED || syncingRef.current || !navigator.onLine) return;
    if (!queueRef.current.length) return;
    syncingRef.current = true; setSyncing(true);
    try {
      while (queueRef.current.length) {
        const { qid, ...delta } = queueRef.current[0];
        const res = await fetch(PROXY_URL, {
          method:"POST", headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({ secret: SHARED_SECRET, ...delta }),
        });
        if (!res.ok) throw new Error("post " + res.status);   // 失敗: 残りは次回再送
        const nq = queueRef.current.slice(1);
        queueRef.current = nq; setQueue(nq); await sset("queue", nq);
      }
    } catch (_) {
      /* オフライン/失敗時はキューを残してリターン。online復帰や次回起動で再送 */
    } finally {
      syncingRef.current = false; setSyncing(false);
    }
  }, []);

  // ── 差分をキューに積んでローカル保存し、即送信を試みる ──
  const enqueue = useCallback(async (delta) => {
    if (!SYNC_ENABLED) return;
    const item = { qid: genId(), date: getToday(), ...delta };
    const nq = [...queueRef.current, item];
    queueRef.current = nq; setQueue(nq); await sset("queue", nq);
    flush();
  }, [flush]);

  // online/offline の検知
  useEffect(() => {
    const on  = () => { setOnline(true); flush(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [flush]);

  useEffect(() => {
    (async () => {
      const [w, c, s, e, g, q] = await Promise.all([sget("wl"), sget("cl"), sget("sl"), sget("el"), sget("goal"), sget("queue")]);
      let wl=w||[], cl=c||[], sl=s||[], el=e||[];
      let gv = (typeof g === "number" && g>=30 && g<=200) ? g : W_GOAL_DEFAULT;
      const pq = Array.isArray(q) ? q : [];
      queueRef.current = pq; setQueue(pq);

      // 1) まずローカルキャッシュで即時表示
      setWLogs(wl); setCLogs(cl); setSLogs(sl); setELogs(el);
      setGoal(gv); setInputGoal(String(gv));
      setLoading(false);

      // 2) 正本(diet.json)を読み戻して上書き（キャッシュ回避の ?t= 付き）
      if (READBACK_ENABLED) {
        try {
          const url = `${DATA_URL}${DATA_URL.includes("?") ? "&" : "?"}t=${Date.now()}`;
          const r = await fetch(url, { cache:"no-store" });
          if (r.ok) {
            let a = entriesToInternal(await r.json());
            if (a.goal === null) a.goal = gv;
            a = pq.reduce((acc, dl) => foldDelta(acc, dl), a);  // 未送信分を上に再適用
            wl=a.wl; cl=a.cl; sl=a.sl; el=a.el; gv=a.goal;
            setWLogs(wl); setCLogs(cl); setSLogs(sl); setELogs(el);
            setGoal(gv); setInputGoal(String(gv));
            await Promise.all([sset("wl",wl), sset("cl",cl), sset("sl",sl), sset("el",el), sset("goal",gv)]);
          }
        } catch (_) { /* オフライン等はキャッシュ表示のまま */ }
      }

      // 3) 今日の入力欄プリフィル
      const td = getToday();
      const tw=wl.find(x=>x.d===td), tc=cl.find(x=>x.d===td), ts=sl.find(x=>x.d===td);
      if (tw) setInputW(String(tw.w));
      if (tc) setInputC(String(tc.c));
      if (ts) setInputS_(String(ts.s));

      // 4) 未送信分があれば再送
      flush();
    })();
  }, [flush]);

  const showToast = (m) => { setToast(m); setTimeout(()=>setToast(""), 2200); };

  // ── Apply parsed structured data to all stores ──
  const applyParsed = async (p) => {
    const td = getToday();
    const done = [];
    const delta = {};
    if (typeof p.weight === "number" && p.weight>=30 && p.weight<=300) {
      const nl = sortByDate([...wLogs.filter(x=>x.d!==td),{d:td,w:p.weight}]);
      setWLogs(nl); await sset("wl",nl); setInputW(String(p.weight));
      delta.weight = p.weight;
      done.push(`体重 ${p.weight}kg`);
    }
    if (typeof p.steps === "number" && p.steps>=0 && p.steps<=99999) {
      const v = Math.round(p.steps);
      const nl = sortByDate([...sLogs.filter(x=>x.d!==td),{d:td,s:v}]);
      setSLogs(nl); await sset("sl",nl); setInputS_(String(v));
      delta.steps = v;
      done.push(`${v.toLocaleString()}歩`);
    }
    if (Array.isArray(p.exercises)) {
      const valid = p.exercises.filter(id=>EXERCISES.some(e=>e.id===id));
      if (valid.length) {
        const cur = eLogs.find(x=>x.d===td)?.types ?? [];
        const merged = Array.from(new Set([...cur, ...valid]));
        const nl = sortByDate([...eLogs.filter(x=>x.d!==td),{d:td,types:merged}]);
        setELogs(nl); await sset("el",nl);
        delta.exercises = merged;   // worker は置換なので、その日の全種目を送る
        done.push(`運動: ${valid.map(id=>EXERCISES.find(e=>e.id===id).label).join("・")}`);
      }
    }
    if (p.food && Array.isArray(p.food.items) && p.food.items.length) {
      const newItems = p.food.items.map(it=>({ name:it.name, kcal:it.kcal||0, id:genId() }));
      const prev = cLogs.find(x=>x.d===td);
      const items = [...(prev?.items ?? []), ...newItems];
      const total = items.reduce((s,x)=>s+(x.kcal||0),0);
      const nl = sortByDate([...cLogs.filter(x=>x.d!==td),{d:td,c:total,items,food:items.map(i=>i.name).join(", ")}]);
      setCLogs(nl); await sset("cl",nl); setInputC(String(total));
      delta.food = { items:newItems };   // 新規itemsのみ送る（workerがidで重複排除しつつappend）
      const added = newItems.reduce((s,x)=>s+(x.kcal||0),0);
      done.push(`食事 +${added}kcal`);
    }
    if (Object.keys(delta).length) enqueue(delta);
    return done;
  };

  const parseAndRecord = async () => {
    if (!nlText.trim()) return;
    setNlBusy(true); setNlError(""); setNlResult("");
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          model:"claude-sonnet-4-20250514", max_tokens:1000,
          messages:[{ role:"user", content:
`あなたはダイエット記録アプリのアシスタントです。ユーザーの自然文から記録項目を抽出し、JSONのみ出力（前置き・マークダウン・説明は一切不要）。

利用可能な運動ID:
squat(スクワット), push(プッシュアップ/腕立て), plank(プランク), lunge(ランジ), hip(ヒップリフト), crunch(クランチ/腹筋), jog(早歩き/ジョギング/ランニング), stair(階段昇降), rope(縄跳び), stretch(ストレッチ)

形式:
{"weight":数値orNull,"steps":整数orNull,"exercises":[該当運動ID...],"food":{"items":[{"name":"項目名","kcal":整数}],"total":整数}orNull}

ルール: 言及がない項目はnull（exercisesは[]）。食事は日本の標準的な1人前で概算。kcalは整数。

ユーザー入力:
${nlText}` }]
        })
      });
      const data = await res.json();
      const text = (data.content||[]).map(i=>i.type==="text"?i.text:"").join("");
      const parsed = JSON.parse(text.replace(/```json|```/g,"").trim());
      const done = await applyParsed(parsed);
      if (done.length) { setNlResult("記録しました ✓  " + done.join("  ・  ")); setNlText(""); }
      else setNlError("記録できる項目を読み取れませんでした。言い換えてみてください。");
    } catch (e) {
      setNlError("解析に失敗しました。もう一度お試しください。");
    } finally { setNlBusy(false); }
  };

  const startVoice = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setNlError("この環境では内蔵マイクに未対応です。キーボードの音声入力をお使いください。"); return; }
    try {
      const r = new SR();
      r.lang = "ja-JP"; r.interimResults = false; r.maxAlternatives = 1;
      r.onresult = (e) => { const t = e.results[0][0].transcript; setNlText(prev => prev ? prev + " " + t : t); };
      r.onerror = () => { setListening(false); setNlError("音声入力できませんでした（マイク権限をご確認ください）。キーボードの音声入力が確実です。"); };
      r.onend = () => setListening(false);
      recRef.current = r; r.start(); setListening(true); setNlError("");
    } catch { setNlError("音声入力を開始できませんでした。"); }
  };
  const stopVoice = () => { try { recRef.current?.stop(); } catch {} setListening(false); };

  // Launch via Shortcuts: ?go=log&focus=1&mic=1 jumps to a tab, focuses input, optionally starts mic
  useEffect(() => {
    try {
      const qs = window.location.search || (window.location.hash.includes("?") ? "?" + window.location.hash.split("?")[1] : "");
      const p = new URLSearchParams(qs);
      const go = p.get("tab") || p.get("go");
      if (go === "log" || go === "graph" || go === "today") setTab(go);
      if (go === "log" && (p.get("focus") === "1" || p.get("focus") === null)) setTimeout(() => textareaRef.current?.focus(), 500);
      if (p.get("mic") === "1") setTimeout(() => startVoice(), 800);
    } catch {}
  }, []);

  const saveWeight = async () => {
    const v = parseFloat(inputW);
    if (isNaN(v)||v<30||v>300) return;
    const td=getToday();
    const nl = sortByDate([...wLogs.filter(x=>x.d!==td),{d:td,w:v}]);
    setWLogs(nl); await sset("wl",nl); enqueue({ weight:v }); showToast("体重を保存しました ✓");
  };
  const saveCal = async () => {
    const v = parseInt(inputC);
    if (isNaN(v)||v<0||v>9999) return;
    const td=getToday();
    const prev = cLogs.find(x=>x.d===td);
    const nl = sortByDate([...cLogs.filter(x=>x.d!==td),{d:td,c:v,items:prev?.items??[],food:prev?.food??""}]);
    setCLogs(nl); await sset("cl",nl); enqueue({ calories:v }); showToast("カロリーを保存しました ✓");
  };
  const saveSteps = async () => {
    const v = parseInt(inputS_);
    if (isNaN(v)||v<0||v>99999) return;
    const td=getToday();
    const nl = sortByDate([...sLogs.filter(x=>x.d!==td),{d:td,s:v}]);
    setSLogs(nl); await sset("sl",nl); enqueue({ steps:v }); showToast("歩数を保存しました ✓");
  };
  const saveGoal = async () => {
    const v = parseFloat(inputGoal);
    if (isNaN(v)||v<30||v>200) return;
    setGoal(v); await sset("goal", v); enqueue({ goal:v }); showToast("目標体重を保存しました ✓");
  };
  const toggleEx = async (id) => {
    const td=getToday();
    const cur = eLogs.find(x=>x.d===td)?.types ?? [];
    const nxt = cur.includes(id)?cur.filter(x=>x!==id):[...cur,id];
    const nl = sortByDate([...eLogs.filter(x=>x.d!==td),...(nxt.length?[{d:td,types:nxt}]:[])]);
    setELogs(nl); await sset("el",nl); enqueue({ exercises:nxt });   // 置換: 解除も同期される
  };

  // ── Derived ──
  const td        = getToday();
  const todayEx   = eLogs.find(x=>x.d===td)?.types ?? [];
  const todayW    = wLogs.find(x=>x.d===td)?.w ?? null;
  const todayCEnt = cLogs.find(x=>x.d===td) ?? null;
  const todayCal  = todayCEnt?.c ?? null;
  const todaySteps= sLogs.find(x=>x.d===td)?.s ?? null;
  const remaining = todayCal!==null ? CAL_TARGET - todayCal : null;
  const stepBurn  = todaySteps!==null ? Math.round(todaySteps*KCAL_PER_STEP) : 0;
  const workoutBurn = todayEx.reduce((s,id)=>s+(EXERCISES.find(e=>e.id===id)?.kcal??0),0);
  const totalBurn = BMR + stepBurn + workoutBurn;
  const balance   = todayCal!==null ? todayCal - totalBurn : null;
  const latestW   = wLogs.length ? wLogs[wLogs.length-1].w : W_START;
  const lost      = W_START - latestW;
  const prog      = Math.max(0, Math.min(100, lost/Math.max(0.1, W_START-goal)*100));

  const streak = (() => {
    let s=0; const d=new Date();
    for (let i=0;i<400;i++){ if(!wLogs.some(x=>x.d===d.toISOString().split("T")[0])) break; s++; d.setDate(d.getDate()-1); }
    return s;
  })();

  const last21 = Array.from({length:21},(_,i)=>{ const d=new Date(); d.setDate(d.getDate()-(20-i)); return d.toISOString().split("T")[0]; });
  const wRangeDef = RANGES.find(r=>r.key===wRange) ?? RANGES[0];
  const wCut  = rangeCutoff(wRangeDef.days);
  const wLong = wRangeDef.days===null || wRangeDef.days>120;
  const wData = sortByDate(wLogs).filter(x=> wCut===null || x.d>=wCut).map(x=>({ date:(wLong?fmtYM(x.d):fmtDate(x.d)), w:x.w }));
  const wTick = wData.length>12 ? Math.floor(wData.length/6) : 0;
  const cData = last21.slice(-14).map(d=>({date:fmtDate(d), c:cLogs.find(x=>x.d===d)?.c ?? null})).filter(x=>x.c!==null);
  const sData = last21.slice(-14).map(d=>({date:fmtDate(d), s:sLogs.find(x=>x.d===d)?.s ?? null})).filter(x=>x.s!==null);

  const tt = { contentStyle:{ background:C.card, border:`1px solid ${C.border}`, color:C.text, fontFamily:"DM Mono", fontSize:12 } };

  // ── 同期ステータス ──
  const pending  = queue.length;
  const syncText = !SYNC_ENABLED ? "ローカルのみ"
                 : !online       ? "オフライン"
                 : syncing       ? "同期中…"
                 : pending       ? `未送信 ${pending}件`
                 :                 "同期済み";
  const syncColor = !SYNC_ENABLED ? C.dim
                  : !online       ? C.warn
                  : syncing       ? C.blue
                  : pending       ? C.warn
                  :                 C.accent;

  if (loading) return (
    <div style={{ background:C.bg, height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:F_MONO }}>
      <span style={{ color:C.mid, letterSpacing:3, fontSize:11 }}>LOADING...</span>
    </div>
  );

  return (
    <div style={{ fontFamily:F_MONO, background:C.bg, minHeight:"100vh", color:C.text, maxWidth:480, margin:"0 auto" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;800&family=DM+Mono:wght@300;400;500&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        input[type=number]{-moz-appearance:textfield}
        input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none}
        textarea{font-family:'DM Mono',monospace}
        button{cursor:pointer}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
      `}</style>

      {/* Header */}
      <div style={{ padding:"22px 20px 14px", borderBottom:`1px solid ${C.border}` }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
          <div>
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              <div style={labelS}>DIET TRACKER</div>
              <span style={{ display:"inline-flex", alignItems:"center", gap:4, fontSize:9, color:syncColor, border:`1px solid ${syncColor}`, borderRadius:10, padding:"1px 7px", letterSpacing:1, fontFamily:F_MONO }}>
                <span style={{ width:5, height:5, borderRadius:"50%", background:syncColor, display:"inline-block", animation:syncing?"pulse 1s infinite":"none" }} />
                {syncText}
              </span>
            </div>
            <div style={{ marginTop:6 }}>
              <span style={{ fontFamily:F_SYNE, fontWeight:800, fontSize:46, lineHeight:1 }}>{latestW.toFixed(1)}</span>
              <span style={{ fontSize:15, color:C.mid, marginLeft:4 }}>kg</span>
            </div>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontFamily:F_SYNE, fontWeight:800, fontSize:32, color:C.accent }}>{streak}</div>
            <div style={{ fontSize:10, color:C.mid, letterSpacing:2 }}>DAY STREAK</div>
          </div>
        </div>
        <div style={{ height:3, background:C.border, borderRadius:2, marginTop:12, overflow:"hidden" }}>
          <div style={{ height:"100%", width:`${prog}%`, background:C.accent, borderRadius:2, transition:"width .6s ease" }} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
          <span style={{ fontSize:10, color:C.mid }}>START {W_START}kg</span>
          <span style={{ fontSize:10, color:C.accent }}>{prog.toFixed(0)}% 達成</span>
          <span style={{ fontSize:10, color:C.mid }}>GOAL {goal}kg</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display:"flex", borderBottom:`1px solid ${C.border}`, background:C.card, position:"sticky", top:0, zIndex:10 }}>
        {[["today","今日"],["log","記録する"],["graph","グラフ"]].map(([id,name])=>(
          <button key={id} onClick={()=>setTab(id)}
            style={{ flex:1, padding:"13px 0", fontSize:11, letterSpacing:2, fontFamily:F_SYNE, fontWeight:600, border:"none", background:"transparent", color:tab===id?C.accent:C.mid, borderBottom:tab===id?`2px solid ${C.accent}`:"2px solid transparent", transition:"color .2s" }}>
            {name}
          </button>
        ))}
      </div>

      <div style={{ padding:"14px 14px 100px" }}>
        {toast && <div style={{ background:C.accentBg, border:`1px solid ${C.accent}`, borderRadius:8, padding:"10px 16px", marginBottom:12, fontSize:12, color:C.accent, textAlign:"center" }}>{toast}</div>}

        {/* ══ TODAY ══ */}
        {tab==="today" && (
          <>
            <div style={cardS}>
              <div style={labelS}>カロリー残量</div>
              {remaining!==null ? (
                <>
                  <div style={{ marginTop:10, display:"flex", alignItems:"baseline", gap:6 }}>
                    <span style={{ fontFamily:F_MONO, fontSize:40, color:remaining<0?C.danger:C.accent }}>{remaining>0?"+":""}{remaining}</span>
                    <span style={{ fontSize:14, color:C.mid }}>kcal</span>
                  </div>
                  <div style={{ height:3, background:C.border, borderRadius:2, marginTop:10, overflow:"hidden" }}>
                    <div style={{ height:"100%", width:`${Math.min(100,todayCal/CAL_TARGET*100)}%`, background:todayCal>CAL_TARGET?C.danger:C.accent, borderRadius:2, transition:"width .4s" }} />
                  </div>
                  <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
                    <span style={{ fontSize:10, color:C.mid }}>摂取 {todayCal?.toLocaleString()} kcal</span>
                    <span style={{ fontSize:10, color:C.mid }}>目標 {CAL_TARGET.toLocaleString()} kcal</span>
                  </div>
                  {todayCEnt?.items?.length>0 && (
                    <div style={{ marginTop:12, borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
                      {todayCEnt.items.map((it,i)=>(
                        <div key={i} style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:C.mid, padding:"2px 0" }}>
                          <span>{it.name}</span><span style={{ fontFamily:F_MONO }}>{it.kcal} kcal</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : <div style={{ fontSize:11, color:C.mid, marginTop:8 }}>「記録する」タブで今日の食事を入力してください</div>}
            </div>

            <div style={cardS}>
              <div style={labelS}>体重</div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:10 }}>
                <div>
                  <span style={{ fontFamily:F_MONO, fontSize:36, color:C.accent }}>{todayW!==null?todayW.toFixed(1):"—"}</span>
                  <span style={{ fontSize:14, color:C.mid, marginLeft:4 }}>kg 今日</span>
                </div>
                <div style={{ textAlign:"right" }}>
                  <span style={{ fontFamily:F_MONO, fontSize:36, color:C.warn }}>{Math.max(0,latestW-goal).toFixed(1)}</span>
                  <span style={{ fontSize:14, color:C.mid, marginLeft:4 }}>kg 残り</span>
                </div>
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>今日の活動量</div>
              <div style={{ display:"flex", justifyContent:"space-between", marginTop:12, gap:8 }}>
                <div style={{ flex:1, textAlign:"center", background:"#07101a", borderRadius:10, padding:"10px 4px", border:`1px solid ${C.border}` }}>
                  <div style={{ fontFamily:F_MONO, fontSize:20, color:C.blue }}>{todaySteps!==null?todaySteps.toLocaleString():"—"}</div>
                  <div style={{ fontSize:10, color:C.mid, marginTop:2 }}>歩数{stepBurn>0?` (約${stepBurn})`:""}</div>
                </div>
                <div style={{ flex:1, textAlign:"center", background:"#07101a", borderRadius:10, padding:"10px 4px", border:`1px solid ${C.border}` }}>
                  <div style={{ fontFamily:F_MONO, fontSize:20, color:C.accent }}>{todayEx.length}</div>
                  <div style={{ fontSize:10, color:C.mid, marginTop:2 }}>運動 種目</div>
                </div>
                <div style={{ flex:1, textAlign:"center", background:"#07101a", borderRadius:10, padding:"10px 4px", border:`1px solid ${C.border}` }}>
                  <div style={{ fontFamily:F_MONO, fontSize:20, color:C.warn }}>{stepBurn+workoutBurn}</div>
                  <div style={{ fontSize:10, color:C.mid, marginTop:2 }}>活動消費 kcal</div>
                </div>
              </div>
              <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginTop:12 }}>
                {todayEx.length ? todayEx.map(id=>{ const e=EXERCISES.find(x=>x.id===id); return <div key={id} style={chip(true)}>✓ {e?.label}</div>; })
                  : <span style={{ fontSize:11, color:C.mid }}>運動の記録はまだありません</span>}
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>1日の消費カロリー</div>
              <div style={{ marginTop:10, display:"flex", alignItems:"baseline", gap:6 }}>
                <span style={{ fontFamily:F_MONO, fontSize:40, color:C.warn }}>{totalBurn.toLocaleString()}</span>
                <span style={{ fontSize:14, color:C.mid }}>kcal 消費</span>
              </div>
              <div style={{ marginTop:12, borderTop:`1px solid ${C.border}`, paddingTop:10 }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:C.mid, padding:"2px 0" }}>
                  <span>基礎代謝（安静時 + 通常活動）</span><span style={{ fontFamily:F_MONO }}>{BMR.toLocaleString()} kcal</span>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:C.mid, padding:"2px 0" }}>
                  <span>歩行</span><span style={{ fontFamily:F_MONO }}>+{stepBurn} kcal</span>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, color:C.mid, padding:"2px 0" }}>
                  <span>運動</span><span style={{ fontFamily:F_MONO }}>+{workoutBurn} kcal</span>
                </div>
              </div>
              {balance!==null && (
                <div style={{ marginTop:10, borderTop:`1px solid ${C.border}`, paddingTop:10, display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
                  <span style={{ fontSize:12, color:C.mid }}>収支（摂取 − 消費）</span>
                  <span style={{ fontFamily:F_MONO, fontSize:18, color:balance<=0?C.accent:C.danger }}>{balance>0?"+":""}{balance.toLocaleString()} kcal</span>
                </div>
              )}
              <div style={{ fontSize:10, color:C.dim, marginTop:8 }}>※ 基礎代謝は安静時1650 + 通常活動170の概算値（{BMR}kcal）。設定で変更したい場合はお知らせください。</div>
            </div>
          </>
        )}

        {/* ══ LOG ══ */}
        {tab==="log" && (
          <>
            {/* ★ Universal NL input */}
            <div style={{ ...cardS, border:`1px solid ${C.accent}`, background:"linear-gradient(180deg,#0c2018,#0c1824)" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <div style={{ ...labelS, color:C.accent }}>CLAUDEに話す</div>
                <span style={{ fontSize:9, color:C.accent, border:`1px solid ${C.accent}`, borderRadius:10, padding:"1px 8px", letterSpacing:1 }}>AI</span>
              </div>
              <div style={{ fontSize:11, color:C.mid, marginTop:6, lineHeight:1.5 }}>体重・運動・歩数・食事をまとめて雑に書くだけ。<br/>例:「今日78.5kg、スクワットとプランクやった、9000歩、昼に牛丼食べた」</div>
              <div style={{ position:"relative", marginTop:10 }}>
                <textarea ref={textareaRef} value={nlText} onChange={e=>setNlText(e.target.value)} rows={3} placeholder="今日のことを話す / 入力する..."
                  style={{ width:"100%", background:"#07101a", border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 44px 10px 12px", color:C.text, fontSize:13, resize:"vertical", lineHeight:1.5 }} />
                <button onClick={listening?stopVoice:startVoice} title="音声入力"
                  style={{ position:"absolute", right:8, top:8, width:30, height:30, borderRadius:"50%", border:`1px solid ${listening?C.danger:C.border}`, background:listening?C.danger:"#0c1824", color:listening?"#fff":C.mid, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, animation:listening?"pulse 1s infinite":"none" }}>
                  {listening?"■":"🎤"}
                </button>
              </div>
              <button onClick={parseAndRecord} disabled={nlBusy||!nlText.trim()}
                style={{ ...btnS, width:"100%", marginTop:10, padding:"12px 0", opacity:(nlBusy||!nlText.trim())?0.5:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8 }}>
                {nlBusy && <span style={{ width:13, height:13, border:"2px solid #051a0f", borderTopColor:"transparent", borderRadius:"50%", display:"inline-block", animation:"spin .7s linear infinite" }} />}
                {nlBusy ? "記録中..." : "AIでまとめて記録"}
              </button>
              {nlResult && <div style={{ fontSize:11, color:C.accent, marginTop:10, lineHeight:1.5 }}>{nlResult}</div>}
              {nlError && <div style={{ fontSize:11, color:C.danger, marginTop:10, lineHeight:1.5 }}>{nlError}</div>}
              <div style={{ fontSize:10, color:C.dim, marginTop:8 }}>※ 内蔵マイクが動かない場合はキーボードの音声入力をご利用ください</div>
            </div>

            <div style={{ fontSize:10, color:C.mid, letterSpacing:2, margin:"18px 4px 8px" }}>── または手入力 ──</div>

            <div style={cardS}>
              <div style={labelS}>体重を記録</div>
              <div style={{ display:"flex", gap:8, marginTop:12, alignItems:"center" }}>
                <input type="number" value={inputW} onChange={e=>setInputW(e.target.value)} placeholder="79.5" step="0.1" style={inputS} />
                <span style={{ fontSize:14, color:C.mid }}>kg</span>
                <button onClick={saveWeight} style={btnS}>保存</button>
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>目標体重を設定</div>
              <div style={{ fontSize:11, color:C.mid, marginTop:4 }}>現在の目標 {goal}kg（あと {Math.max(0,latestW-goal).toFixed(1)}kg）</div>
              <div style={{ display:"flex", gap:8, marginTop:12, alignItems:"center" }}>
                <input type="number" value={inputGoal} onChange={e=>setInputGoal(e.target.value)} placeholder="69" step="0.5" style={inputS} />
                <span style={{ fontSize:14, color:C.mid }}>kg</span>
                <button onClick={saveGoal} style={btnS}>保存</button>
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>摂取カロリーを記録</div>
              <div style={{ fontSize:11, color:C.mid, marginTop:4 }}>合計を直接入力（目標 {CAL_TARGET.toLocaleString()} kcal）</div>
              <div style={{ display:"flex", gap:8, marginTop:12, alignItems:"center" }}>
                <input type="number" value={inputC} onChange={e=>setInputC(e.target.value)} placeholder="1800" style={inputS} />
                <span style={{ fontSize:14, color:C.mid }}>kcal</span>
                <button onClick={saveCal} style={btnS}>保存</button>
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>歩数を記録</div>
              <div style={{ fontSize:11, color:C.mid, marginTop:4 }}>ヘルスケア/スマホの数字を入力</div>
              <div style={{ display:"flex", gap:8, marginTop:12, alignItems:"center" }}>
                <input type="number" value={inputS_} onChange={e=>setInputS_(e.target.value)} placeholder="8000" style={inputS} />
                <span style={{ fontSize:14, color:C.mid }}>歩</span>
                <button onClick={saveSteps} style={btnS}>保存</button>
              </div>
            </div>

            <div style={cardS}>
              <div style={labelS}>運動を記録</div>
              {CATS.map(cat=>(
                <div key={cat} style={{ marginTop:14 }}>
                  <div style={{ fontSize:10, color:C.accent, letterSpacing:2, marginBottom:8 }}>{cat}</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {EXERCISES.filter(e=>e.cat===cat).map(ex=>{
                      const done = todayEx.includes(ex.id);
                      return (
                        <button key={ex.id} onClick={()=>toggleEx(ex.id)}
                          style={{ display:"flex", alignItems:"center", gap:12, width:"100%", textAlign:"left", background:done?C.accentBg:"#07101a", border:`1px solid ${done?C.accent:C.border}`, borderRadius:10, padding:"12px 14px", transition:"all .2s" }}>
                          <div style={{ width:22, height:22, borderRadius:"50%", border:`2px solid ${done?C.accent:C.dim}`, background:done?C.accent:"transparent", display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, color:done?"#051a0f":"transparent", fontWeight:700, flexShrink:0 }}>{done?"✓":""}</div>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:13, color:C.text }}>{ex.label}</div>
                            <div style={{ fontSize:11, color:C.mid, marginTop:2 }}>{ex.vol} ・ 約{ex.kcal} kcal</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ══ GRAPH ══ */}
        {tab==="graph" && (
          <>
            <div style={cardS}>
              <div style={labelS}>体重の推移（{wRangeDef.label}）</div>
              <div style={{ display:"flex", gap:6, marginTop:10 }}>
                {RANGES.map(r=>(
                  <button key={r.key} onClick={()=>setWRange(r.key)}
                    style={{ flex:1, padding:"6px 0", fontSize:11, borderRadius:8, border:`1px solid ${wRange===r.key?C.accent:C.border}`, background:wRange===r.key?C.accentBg:"transparent", color:wRange===r.key?C.accent:C.mid, fontFamily:F_MONO }}>
                    {r.label}
                  </button>
                ))}
              </div>
              {wData.length<2 ? <div style={{ fontSize:12, color:C.mid, textAlign:"center", padding:"20px 0" }}>この期間の記録が2件以上になるとグラフが表示されます</div> : (
                <div style={{ marginTop:12 }}>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={wData} margin={{top:5,right:10,left:-25,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="date" interval={wTick} tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <YAxis domain={["auto","auto"]} tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <Tooltip {...tt} formatter={v=>[`${v} kg`,"体重"]} />
                      <ReferenceLine y={goal} stroke={C.warn} strokeDasharray="5 5" />
                      <Line type="monotone" dataKey="w" stroke={C.accent} strokeWidth={2.5} dot={wData.length>60?false:{fill:C.accent,r:4,strokeWidth:0}} activeDot={{r:6}} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div style={{ display:"flex", gap:16, marginTop:6, paddingLeft:4 }}>
                    <span style={{ fontSize:10, color:C.accent }}>— 体重</span>
                    <span style={{ fontSize:10, color:C.warn }}>- - 目標 {goal}kg</span>
                  </div>
                </div>
              )}
            </div>

            <div style={cardS}>
              <div style={labelS}>摂取カロリー（直近14日）</div>
              {cData.length<1 ? <div style={{ fontSize:12, color:C.mid, textAlign:"center", padding:"20px 0" }}>データがありません</div> : (
                <div style={{ marginTop:12 }}>
                  <ResponsiveContainer width="100%" height={170}>
                    <BarChart data={cData} margin={{top:5,right:10,left:-25,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="date" tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <YAxis tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <Tooltip {...tt} formatter={v=>[`${v} kcal`,"摂取"]} />
                      <ReferenceLine y={CAL_TARGET} stroke={C.warn} strokeDasharray="5 5" />
                      <Bar dataKey="c" fill={C.accent} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            <div style={cardS}>
              <div style={labelS}>歩数（直近14日）</div>
              {sData.length<1 ? <div style={{ fontSize:12, color:C.mid, textAlign:"center", padding:"20px 0" }}>データがありません</div> : (
                <div style={{ marginTop:12 }}>
                  <ResponsiveContainer width="100%" height={170}>
                    <BarChart data={sData} margin={{top:5,right:10,left:-15,bottom:5}}>
                      <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                      <XAxis dataKey="date" tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <YAxis tick={{fill:C.mid,fontSize:10,fontFamily:"DM Mono"}} />
                      <Tooltip {...tt} formatter={v=>[`${v.toLocaleString()} 歩`,"歩数"]} />
                      <ReferenceLine y={8000} stroke={C.blue} strokeDasharray="5 5" />
                      <Bar dataKey="s" fill={C.blue} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ fontSize:10, color:C.blue, marginTop:6, paddingLeft:4 }}>- - 目安 8,000歩</div>
                </div>
              )}
            </div>

            <div style={cardS}>
              <div style={labelS}>サマリー</div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginTop:12 }}>
                {[
                  { label:"記録日数", val:`${wLogs.length}日` },
                  { label:"連続記録", val:`${streak}日` },
                  { label:"最高体重", val:wLogs.length?`${Math.max(...wLogs.map(x=>x.w)).toFixed(1)}kg`:"—" },
                  { label:"最低体重", val:wLogs.length?`${Math.min(...wLogs.map(x=>x.w)).toFixed(1)}kg`:"—" },
                ].map(({label,val})=>(
                  <div key={label} style={{ background:"#07101a", border:`1px solid ${C.border}`, borderRadius:10, padding:12, textAlign:"center" }}>
                    <div style={{ fontFamily:F_SYNE, fontWeight:700, fontSize:22, color:C.text }}>{val}</div>
                    <div style={{ fontSize:10, color:C.mid, letterSpacing:1, marginTop:4 }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
