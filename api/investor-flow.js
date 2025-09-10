// api/investor-flow.js
export default async function handler(req, res) {
  try {
    // ── 인증 & 메서드 ─────────────────────────────────────
    const tok = req.headers["x-client-token"];
    if (!tok || tok !== process.env.CLIENT_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    // ── 파라미터 ──────────────────────────────────────────
    const symbol = (req.query.symbol || "").toString().trim();
    const date = (req.query.date || "").toString().trim();   // YYYY-MM-DD
    const debug = req.query.debug === "1";                    // ?debug=1 → 원본보기

    if (!/^\d{6}$/.test(symbol)) {
      return res.status(400).json({ ok: false, error: "invalid_symbol", hint: "use 6-digit KRX code, e.g., 005930" });
    }
    if (!isDate(date)) {
      return res.status(400).json({ ok: false, error: "invalid_date", hint: "use YYYY-MM-DD" });
    }
    const ymd = date.replaceAll("-", "");

    // ── 토큰 발급 ─────────────────────────────────────────
    const token = await getPaperToken();

    // ── 업스트림 호출 준비 ────────────────────────────────
    const TR_ID = process.env.KIS_TR_ID_INVESTOR_DAILY || "FHKST03010200"; // 문서에 맞게 교체 권장
    const headers = {
      authorization: `Bearer ${token}`,
      appkey: must(process.env.KIS_APP_KEY, "KIS_APP_KEY"),
      appsecret: must(process.env.KIS_APP_SECRET, "KIS_APP_SECRET"),
      tr_id: TR_ID,
      Accept: "application/json",
    };

    // 우선순위: 환경변수 KIS_FLOW_PATH > 후보 경로들
    const base = getBase();
    const candidates = [];
    if (process.env.KIS_FLOW_PATH) candidates.push(base + process.env.KIS_FLOW_PATH);
    candidates.push(
      `${base}/uapi/domestic-stock/v1/quotations/inquire-investor`,
      `${base}/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily`,
      `${base}/uapi/domestic-stock/v1/quotations/inquire-investor-volume`,
      `${base}/uapi/domestic-stock/v1/quotations/inquire-investor-trend`
    );

    // 파라미터 후보 (계정/문서 버전별 상이)
    const paramsList = [
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_DATE_1: ymd },
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_DATE: ymd },
      { FID_INPUT_ISCD: symbol, FID_INPUT_YYYYMMDD: ymd },
      { symbol, date: ymd },
      { symbol, date }
    ];

    let lastErr = null;
    let usedUrl = null;
    let upstream = null;

    // ── 후보 엔드포인트 × 파라미터 조합 시도 ────────────────
    for (const urlBase of candidates) {
      for (const p of paramsList) {
        const url = urlBase + "?" + new URLSearchParams(p).toString();
        usedUrl = url;
        try {
          const r = await fetchWithTimeout(url, { headers }, 10000);
          const j = await r.json().catch(() => null);
          upstream = j;

          if (!r.ok) { lastErr = `HTTP ${r.status} @ ${url}`; continue; }
          // KIS 응답: 보통 rt_cd === "0" 이 성공
          if (j && (j.rt_cd === "0" || j.output || j.data || j.result)) {
            const o = Array.isArray(j?.output) ? j.output[0] : j?.output || j?.data || j;

            if (debug) {
              return res.status(200).json({
                ok: true,
                debug: {
                  used_url: url,
                  tr_id: TR_ID,
                  upstream_rt_cd: j?.rt_cd ?? null,
                  output_keys: o ? Object.keys(o) : [],
                },
                raw: j
              });
            }

            // ── 응답 매핑 (여러 후보 키 지원) ───────────────
            const foreignVol = pickNum(o, [
              "frgn_ntby_qty", "frgn_net_buy_qty", "frgn_nt", "frgn_sm_netb_qty", "frgn_bsop_netqty"
            ]);
            const foreignAmt = pickNum(o, [
              "frgn_ntby_tr_amt", "frgn_net_buy_amt", "frgn_sm_netb_tr_am", "frgn_bsop_netamt"
            ]);
            const instVol = pickNum(o, [
              "orgn_ntby_qty", "inst_sum_ntby_qty", "org_ntby_qty", "inst_net_buy_qty"
            ]);
            const instAmt = pickNum(o, [
              "orgn_ntby_tr_amt", "inst_sum_ntby_tr_amt", "org_ntby_tr_amt", "inst_net_buy_amt"
            ]);

            return res.status(200).json({
              ok: true,
              symbol,
              date,
              foreign: { netBuyVolume: foreignVol, netBuyValue: foreignAmt },
              institution: { netBuyVolume: instVol, netBuyValue: instAmt }
            });
          } else {
            lastErr = `unexpected_body @ ${url}`;
          }
        } catch (e) {
          lastErr = `fetch_err @ ${url}: ${String(e)}`;
        }
      }
    }

    // 전부 실패한 경우
    return res.status(502).json({
      ok: false,
      error: "upstream_no_flow_data",
      detail: lastErr,
      tried_url: usedUrl,
      raw_preview: upstream ? Object.keys(upstream).slice(0, 10) : null
    });

  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    return res.status(502).json({ ok: false, error: msg });
  }
}

/* ───────── helpers ───────── */
function must(v, name) { if (!v) throw new Error(`Missing env: ${name}`); return v; }
function getBase() { return process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443"; }
function isDate(s){ return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s).getTime()); } // ← $ 잘못 이스케이프하지 마세요
function toNum(v){ if(v==null||v==="")return 0; const n=Number(String(v).replaceAll(",","").trim()); return Number.isFinite(n)?n:0; }
function pickNum(obj, keys){ if(!obj) return 0; for(const k of keys){ const v = toNum(obj[k]); if(v) return v; } return 0; }
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
