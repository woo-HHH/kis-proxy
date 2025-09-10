// api/investor-flow.js
export default async function handler(req, res) {
  try {
    const tok = req.headers["x-client-token"];
    if (!tok || tok !== process.env.CLIENT_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const symbol = (req.query.symbol || "").toString().trim();
    const date = (req.query.date || "").toString().trim(); // YYYY-MM-DD
    if (!/^\d{6}$/.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid_symbol", hint: "use 6-digit KRX code, e.g., 005930" });
    }
    if (!isDate(date)) {
      return res.status(400).json({ ok: false, error: "invalid_date", hint: "use YYYY-MM-DD" });
    }
    const ymd = date.replaceAll("-", "");

    const token = await getPaperToken();
    const headers = {
      authorization: `Bearer ${token}`,
      appkey: must(process.env.KIS_APP_KEY, "KIS_APP_KEY"),
      appsecret: must(process.env.KIS_APP_SECRET, "KIS_APP_SECRET"),
      tr_id: process.env.KIS_TR_ID_INVESTOR_DAILY || "FHKST03010200", // 문서값으로 바꾸세요
      Accept: "application/json",
    };

    // KIS 문서: 종목별 투자자매매동향(일별) (파라미터는 계정/환경별로 다를 수 있음)
    const url = `${getBase()}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily?` +
      new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: symbol,
        FID_INPUT_DATE_1: ymd
      });

    const r = await fetchWithTimeout(url, { headers }, 10000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j?.rt_cd === "1") {
      return res.status(502).json({ ok: false, error: "upstream_failed" });
    }

    // ◼︎ 응답 매핑 (필드명은 계정/문서 버전에 따라 다를 수 있음 → 필요 시 수정)
    const o = Array.isArray(j?.output) ? j.output[0] : j?.output || j;
    // 대표 필드 가정 (없으면 0): frgn_ntby_qty / orgn_ntby_qty, ... 금액 필드가 다르면 교체
    const result = {
      symbol,
      date,
      foreign: {
        netBuyVolume: num(o?.frgn_ntby_qty ?? o?.frgn_net_buy_qty ?? o?.frgn_nt ?? 0),
        netBuyValue:  num(o?.frgn_ntby_tr_amt ?? o?.frgn_net_buy_amt ?? 0)
      },
      institution: {
        netBuyVolume: num(o?.orgn_ntby_qty ?? o?.inst_sum_ntby_qty ?? 0),
        netBuyValue:  num(o?.orgn_ntby_tr_amt ?? o?.inst_sum_ntby_tr_amt ?? 0)
      },
      raw: process.env.DEBUG_RAW === "1" ? o : undefined
    };

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    return res.status(502).json({ ok: false, error: msg });
  }
}

/* ---------- helpers ---------- */
function must(v, name) { if (!v) throw new Error(`Missing env: ${name}`); return v; }
function getBase() { return process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443"; }
function isDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime()); }
function num(v){ if(v==null||v==="")return 0; const n=Number(String(v).replaceAll(",","").trim()); return Number.isFinite(n)?n:0; }
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
