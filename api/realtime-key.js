// api/realtime-key.js
export default async function handler(req, res) {
  try {
    const tok = req.headers["x-client-token"];
    if (!tok || tok !== process.env.CLIENT_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const token = await getPaperToken();
    const headers = {
      authorization: `Bearer ${token}`,
      appkey: must(process.env.KIS_APP_KEY, "KIS_APP_KEY"),
      appsecret: must(process.env.KIS_APP_SECRET, "KIS_APP_SECRET"),
      tr_id: process.env.KIS_TR_ID_REALTIME || "H0STCNT0", // 문서 기준으로 바꾸세요
      Accept: "application/json",
    };

    // 엔드포인트/파라미터는 문서대로 조정
    const url = `${getBase()}${process.env.KIS_REALTIME_PATH || "/uapi/domestic-stock/v1/real-time/issue-key"}`;

    const r = await fetchWithTimeout(url, { headers }, 10000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ ok: false, error: "upstream_failed", detail: j });

    return res.status(200).json({ ok: true, data: j });
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    return res.status(502).json({ ok: false, error: msg });
  }
}

/* helpers */
function must(v, name) { if (!v) throw new Error(`Missing env: ${name}`); return v; }
function getBase() { return process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443"; }
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
