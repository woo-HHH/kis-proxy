// api/price.js
export default async function handler(req, res) {
  try {
    // --- 인증 ---
    const tok = req.headers["x-client-token"];
    if (!tok || tok !== process.env.CLIENT_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const symbol = (req.query.symbol || "").toString().trim();
    const full = req.query.full === "1";
    const fieldsParam = (req.query.fields || "").toString().trim();

    if (!/^\d{6}$/.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid_symbol", hint: "use 6-digit KRX code, e.g., 005930" });
    }

    // --- 토큰 발급 (paper) ---
    const token = await getPaperToken();

    // --- KIS 시세 조회 ---
    const url = `${getBase()}/uapi/domestic-stock/v1/quotations/inquire-price?` +
      new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol });

    const headers = {
      authorization: `Bearer ${token}`,
      appkey: must(process.env.KIS_APP_KEY, "KIS_APP_KEY"),
      appsecret: must(process.env.KIS_APP_SECRET, "KIS_APP_SECRET"),
      tr_id: "FHKST01010100",
      Accept: "application/json",
    };

    const qResp = await fetchWithTimeout(url, { headers }, 10000);
    const qJson = await qResp.json().catch(() => ({}));

    if (!qResp.ok || qJson?.rt_cd === "1") {
      return res.status(502).json({ ok: false, error: "quote_failed" });
    }

    const o = qJson.output || {};
    if (full) {
      return res.json({ ok: true, data: o.stck_shrn_iscd ? o : qJson });
    }

    const slim = {
      code: o.stck_shrn_iscd,
      price: num(o.stck_prpr),
      change: num(o.prdy_vrss),
      changeRate: num(o.prdy_ctrt),
      open: num(o.stck_oprc),
      high: num(o.stck_hgpr),
      low: num(o.stck_lwpr),
      volume: num(o.acml_vol),
      amount: num(o.acml_tr_pbmn),
      foreignerRate: num(o.hts_frgn_ehrt),
      market: o.rprs_mrkt_kor_name,
      timestamp: new Date().toISOString()
    };

    let payload = slim;
    if (fieldsParam) {
      const keys = fieldsParam.split(",").map(s => s.trim()).filter(Boolean);
      payload = pick(slim, keys.length ? keys : ["code", "price", "changeRate"]);
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, data: payload });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    return res.status(502).json({ ok: false, error: msg });
  }
}

/* ---------- helpers (파일 하단에 공통 유틸) ---------- */
function must(v, name) { if (!v) throw new Error(`Missing env: ${name}`); return v; }
function getBase() { return process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443"; }
function num(v){ if(v==null||v==="")return 0; const n=Number(String(v).replaceAll(",","").trim()); return Number.isFinite(n)?n:0; }
function pick(obj, keys){ const o={}; for(const k of keys) if(obj[k]!==undefined) o[k]=obj[k]; return o; }
async function fetchWithTimeout(url, options={}, timeoutMs=10000){
  const controller = new AbortController(); const id=setTimeout(()=>controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(id); }
}
let _tok=null,_ts=0,_p=null;
async function getPaperToken(){
  const now=Date.now(); if(_tok && now-_ts<60000) return _tok; if(_p) return _p;
  _p=(async ()=>{
    const r=await fetchWithTimeout(`${getBase()}/oauth2/tokenP`,{
      method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ grant_type:"client_credentials", appkey: must(process.env.KIS_APP_KEY,"KIS_APP_KEY"), appsecret: must(process.env.KIS_APP_SECRET,"KIS_APP_SECRET") })
    },10000);
    const j=await r.json().catch(()=>({})); if(!r.ok || !j?.access_token){ _p=null; throw new Error("token_issue_failed"); }
    _tok=j.access_token; _ts=Date.now(); _p=null; return _tok;
  })();
  return _p;
}
