// api/index.js
import express from "express";
import dotenv from "dotenv";
import compression from "compression";

dotenv.config(); // .env 로드 (로컬/개발환경)

// ==== 앱 기본 설정 ====
const app = express();
app.use(compression());     // gzip 압축 (app 생성 후)
app.use(express.json());    // JSON 파서

// 보안 헤더(간단)
app.use((_, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// ── 필수 환경변수 점검 ─────────────────────────────────────────
const must = (v, name) => {
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
};
const CLIENT_TOKEN = must(process.env.CLIENT_TOKEN, "CLIENT_TOKEN");
const KIS_BASE = process.env.KIS_BASE || "https://openapi.koreainvestment.com:9443";
const KIS_APP_KEY = must(process.env.KIS_APP_KEY, "KIS_APP_KEY");
const KIS_APP_SECRET = must(process.env.KIS_APP_SECRET, "KIS_APP_SECRET");

// optional: 업스트림에서 투자자별 수급을 조회할 경로(경로만, KIS_BASE 뒤에 붙음)
// 예: /uapi/domestic-stock/v1/quotations/inquire-investor
const KIS_FLOW_PATH = process.env.KIS_FLOW_PATH || "";

// ── 유틸: 타임아웃 있는 fetch ─────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

// ── 유틸: 로그 안전화(민감정보 마스킹) ────────────────────────
const safeDetail = (obj) => {
  try {
    const s = JSON.stringify(obj);
    return s
      .replaceAll(process.env.KIS_APP_KEY ?? "", "***APP_KEY***")
      .replaceAll(process.env.KIS_APP_SECRET ?? "", "***APP_SECRET***")
      .replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, "Bearer ***TOKEN***");
  } catch {
    return String(obj);
  }
};

// ── 간단 레이트리밋(서버리스 친화) ────────────────────────────
const hits = new Map();
const WINDOW_MS = 10_000; // 10초
const MAX_HITS = 30;      // 윈도 내 최대 30회
app.use((req, res, next) => {
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim()
    || req.socket.remoteAddress || "0";
  const now = Date.now();
  const h = hits.get(ip) || { count: 0, ts: now };
  if (now - h.ts > WINDOW_MS) { h.count = 0; h.ts = now; }
  h.count++;
  hits.set(ip, h);
  if (h.count > MAX_HITS) return res.status(429).json({ ok: false, error: "rate_limited" });
  next();
});

// ── 헬스체크(무인증) ───────────────────────────────────────────
app.get("/", (_req, res) =>
  res.json({ ok: true, service: "KIS proxy (paper, readonly)" })
);

// ── 인증 미들웨어(이후 모든 경로 보호) ─────────────────────────
app.use((req, res, next) => {
  if (req.path === "/") return next(); // 루트만 예외(원하면 제거)
  const tok = req.header("X-Client-Token");
  if (!tok || tok !== CLIENT_TOKEN) return res.status(401).json({ ok: false, error: "unauthorized" });
  next();
});

// ── 토큰 캐싱 + 락(분당 1회 발급 제한 대응) ────────────────────
let cachedToken = null;
let tokenIssuedAt = 0;
let tokenPromise = null;

async function getPaperToken() {
  const now = Date.now();
  if (cachedToken && (now - tokenIssuedAt) < 60_000) return cachedToken; // 60초 재사용
  if (tokenPromise) return tokenPromise; // 동시발급 방지

  tokenPromise = (async () => {
    const resp = await fetchWithTimeout(`${KIS_BASE}/oauth2/tokenP`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
      }),
    }, 10000);

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data?.access_token) {
      tokenPromise = null;
      throw new Error(`token_issue_failed:${safeDetail(data)}`);
    }
    cachedToken = data.access_token;
    tokenIssuedAt = Date.now();
    tokenPromise = null;
    return cachedToken;
  })();

  return tokenPromise;
}

// ── (디버그) 모의토큰 프리뷰 ───────────────────────────────────
app.get("/kis/token", async (_req, res) => {
  try {
    const t = await getPaperToken();
    res.json({ ok: true, access_token_preview: t.slice(0, 10) + "...", raw_expires_in: 86400 });
  } catch (e) {
    const msg = String(e);
    const isTokenFail = msg.includes("token_issue_failed");
    res.status(502).json({ ok: false, error: isTokenFail ? "token_issue_failed" : msg });
  }
});

// ── helpers ───────────────────────────────────────────────────
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// parse numeric-ish value (string or number) to Number or 0
function toNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number(v);
  if (typeof v === "string") {
    const n = Number(v.replaceAll(",", "").trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// ── 기존 /kis/price 라우트 (변경 없음) ─────────────────────────
app.get("/kis/price", async (req, res) => {
  const symbol = (req.query.symbol || "").toString().trim();
  const full = req.query.full === "1";                      // ?full=1 → 원본(디버그용)
  const fieldsParam = (req.query.fields || "").toString().trim(); // ?fields=code,price,changeRate

  if (!/^\d{6}$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: "invalid_symbol", hint: "use 6-digit KRX code, e.g., 005930" });
  }
  try {
    const ACCESS_TOKEN = await getPaperToken();
    const headers = {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: "FHKST01010100",
      Accept: "application/json",
    };
    const url = `${KIS_BASE}/uapi/domestic-stock/v1/quotations/inquire-price?` +
      new URLSearchParams({ FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol });

    const qResp = await fetchWithTimeout(url, { headers }, 10000);
    const qJson = await qResp.json().catch(() => ({}));

    if (!qResp.ok || qJson?.rt_cd === "1") {
      // 에러 응답은 초슬림 (큰 detail 제거)
      return res.status(502).json({ ok: false, error: "quote_failed" });
    }

    const o = qJson.output || {};
    if (full) {
      // 디버그용: 원본(또는 output만) — GPTs에서는 사용 자제
      return res.json({ ok: true, data: o.stck_shrn_iscd ? o : qJson });
    }

    // 🔻 기본: 초슬림(필요 최소만)
    const slim = {
      code: o.stck_shrn_iscd,            // 종목코드
      price: Number(o.stck_prpr),        // 현재가
      change: Number(o.prdy_vrss),       // 전일대비
      changeRate: Number(o.prdy_ctrt),   // 등락률(%)
      open: Number(o.stck_oprc),
      high: Number(o.stck_hgpr),
      low: Number(o.stck_lwpr),
      volume: Number(o.acml_vol),
      amount: Number(o.acml_tr_pbmn),
      foreignerRate: Number(o.hts_frgn_ehrt),
      market: o.rprs_mrkt_kor_name,
    };

    // 선택 필드만: ?fields=code,price,changeRate
    let payload = slim;
    if (fieldsParam) {
      const keys = fieldsParam.split(",").map(s => s.trim()).filter(Boolean);
      payload = pick(slim, keys.length ? keys : ["code","price","changeRate"]);
    }

    // 사이즈 가드(20KB 초과 시 초초슬림)
    let body = JSON.stringify({ ok: true, data: payload });
    if (Buffer.byteLength(body, "utf8") > 20_000) {
      const ultra = pick(slim, ["code","price","changeRate","volume"]);
      body = JSON.stringify({ ok: true, data: ultra, truncated: true });
    }

    res.setHeader("Cache-Control", "no-store"); // 실시간성
    res.type("application/json").send(body);
  } catch (e) {
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    res.status(502).json({ ok: false, error: msg });
  }
});

// ── NEW: 특정일(YYYY-MM-DD) 외인/기관 수급 조회 ─────────────────
/**
 * GET /kis/flow?symbol=005930&date=2025-09-09
 *
 * 기본 동작:
 *  - symbol: 6-digit KRX code (필수)
 *  - date: YYYY-MM-DD (필수)
 * 
 * 업스트림 경로:
 *  - 우선 process.env.KIS_FLOW_PATH 사용 (경로만, KIS_BASE 뒤에 붙임)
 *  - 없으면 CANDIDATE_PATHS 중 시도
 * 
 * 응답: { ok: true, symbol, date, flows: { foreign, institution, retail }, rawCount }
 */
function isValidDateString(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(new Date(d).getTime());
}

// 유연한 응답 파싱: 다양한 upstream 스키마를 허용하여 외인/기관 순매수 계산
function parseInvestorResponse(json) {
  // 가능한 패턴을 탐색하고 숫자형으로 변환하여 누적
  const out = { foreign: 0, institution: 0, retail: 0 };

  // helper: try common keys
  const tryKeyPair = (obj, buyKey, sellKey, target) => {
    if (!obj) return false;
    const b = toNum(obj[buyKey]);
    const s = toNum(obj[sellKey]);
    if (b || s) { out[target] += (b - s); return true; }
    return false;
  };

  // 1) flat fields like foreign_buy / foreign_sell or foreignBuy / foreignSell
  tryKeyPair(json, "foreign_buy", "foreign_sell", "foreign") ||
  tryKeyPair(json, "foreignBuy", "foreignSell", "foreign");
  tryKeyPair(json, "inst_buy", "inst_sell", "institution") ||
  tryKeyPair(json, "instBuy", "instSell", "institution");
  tryKeyPair(json, "retail_buy", "retail_sell", "retail") ||
  tryKeyPair(json, "retailBuy", "retailSell", "retail");

  // 2) nested output object (common in KIS responses)
  const possibleContainers = [json.output, json.data, json.result, json.body, json.response];
  for (const c of possibleContainers) {
    if (!c) continue;
    tryKeyPair(c, "frgn_nt", "frgn_sell", "foreign") // custom
    tryKeyPair(c, "frgn_buy", "frgn_sell", "foreign")
    tryKeyPair(c, "foreign_buy", "foreign_sell", "foreign")
    tryKeyPair(c, "foreignBuy", "foreignSell", "foreign")
    tryKeyPair(c, "inst_buy", "inst_sell", "institution")
    tryKeyPair(c, "instBuy", "instSell", "institution")
    tryKeyPair(c, "foreigner_buy", "foreigner_sell", "foreign")
    // KIS sometimes returns arrays: investorSummary or list
    if (Array.isArray(c.investor) || Array.isArray(c.investorSummary) || Array.isArray(c.list)) {
      const arr = c.investor || c.investorSummary || c.list;
      for (const it of arr) {
        const role = (it.type || it.investorType || it.category || it.name || "").toString().toLowerCase();
        const buy = toNum(it.buy || it.buy_amt || it.bsBuy || it.bs_buy || it.bp_buy);
        const sell = toNum(it.sell || it.sell_amt || it.bsSell || it.bs_sell || it.bp_sell);
        if (role.includes("foreign") || role.includes("외") || role.includes("foreigners") || role.includes("frgn")) out.foreign += (buy - sell);
        else if (role.includes("inst") || role.includes("institution") || role.includes("기관")) out.institution += (buy - sell);
        else if (role.includes("retail") || role.includes("개인") || role.includes("ret")) out.retail += (buy - sell);
      }
    }
  }

  // 3) if top-level has arrays like trades: try to aggregate by investorType field
  if (Array.isArray(json.trades) || Array.isArray(json.items) || Array.isArray(json.records)) {
    const arr = json.trades || json.items || json.records;
    for (const t of arr) {
      const investor = (t.investorType || t.type || t.accType || t.owner || "").toString().toLowerCase();
      const buy = toNum(t.buy || t.buyAmt || t.bp_buy || t.bsBuy || t.buy_amount);
      const sell = toNum(t.sell || t.sellAmt || t.bp_sell || t.bsSell || t.sell_amount);
      if (investor.includes("foreign") || investor.includes("frgn") || investor.includes("외")) out.foreign += (buy - sell);
      else if (investor.includes("inst") || investor.includes("institution") || investor.includes("기관")) out.institution += (buy - sell);
      else out.retail += (buy - sell);
    }
  }

  return out;
}

// candidate paths (relative to KIS_BASE) to try when KIS_FLOW_PATH not provided.
// These are best-effort guesses; real path may vary per vendor/account.
const CANDIDATE_PATHS = [
  "/uapi/domestic-stock/v1/quotations/inquire-investor",   // plausible
  "/uapi/domestic-stock/v1/quotations/inquire-investor-volume",
  "/uapi/domestic-stock/v1/quotations/inquire-investor-trend",
  "/uapi/domestic-stock/v1/quotations/inquire-trades"      // generic trades
];

app.get("/kis/flow", async (req, res) => {
  const symbol = (req.query.symbol || "").toString().trim();
  const date = (req.query.date || "").toString().trim(); // expect YYYY-MM-DD

  if (!/^\d{6}$/.test(symbol)) {
    return res.status(400).json({ ok: false, error: "invalid_symbol", hint: "use 6-digit KRX code, e.g., 005930" });
  }
  if (!isValidDateString(date)) {
    return res.status(400).json({ ok: false, error: "invalid_date", hint: "use YYYY-MM-DD" });
  }

  try {
    const ACCESS_TOKEN = await getPaperToken();
    const baseHeaders = {
      authorization: `Bearer ${ACCESS_TOKEN}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      Accept: "application/json",
    };

    // build candidate URLs: prefer env-configured path first
    const candidates = [];
    if (KIS_FLOW_PATH) {
      candidates.push(`${KIS_BASE}${KIS_FLOW_PATH}`);
    }
    for (const p of CANDIDATE_PATHS) candidates.push(`${KIS_BASE}${p}`);

    let lastErr = null;
    let parsedFlows = null;
    let rawJson = null;
    let usedUrl = null;

    // try each candidate until we get a 200 with JSON we can parse
    for (const urlBase of candidates) {
      // many upstream APIs use YYYYMMDD (no '-') for date params — try both
      const dateNoDash = date.replaceAll("-", "");
      // try two common param sets
      const tryParamsList = [
        { FID_INPUT_ISCD: symbol, FID_INPUT_DATE: dateNoDash }, // generic KIS style
        { symbol, date: dateNoDash },
        { symbol, date }, // with dash
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_YYYYMMDD: dateNoDash },
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_DATE: dateNoDash },
        { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: symbol, FID_INPUT_DATE: date }
      ];

      let ok = false;
      for (const params of tryParamsList) {
        const url = urlBase + "?" + new URLSearchParams(params).toString();
        usedUrl = url;
        try {
          const resp = await fetchWithTimeout(url, { headers: baseHeaders }, 10_000);
          const j = await resp.json().catch(() => null);
          if (!resp.ok) {
            lastErr = `upstream ${resp.status} ${resp.statusText} @ ${url} ${safeDetail(j)}`;
            continue;
          }
          if (!j) { lastErr = `empty_json @ ${url}`; continue; }
          // parse investor info
          rawJson = j;
          parsedFlows = parseInvestorResponse(j);
          ok = true;
          break;
        } catch (e) {
          lastErr = `fetch_err @ ${url} : ${String(e)}`;
        }
      }
      if (ok) break;
    }

    if (!parsedFlows) {
      // couldn't parse from any upstream — return 502 with diagnostic
      return res.status(502).json({
        ok: false,
        error: "upstream_no_flow_data",
        detail: lastErr,
        triedUrl: usedUrl,
      });
    }

    // respond with aggregated flows
    const flows = {
      foreign: Math.round(parsedFlows.foreign),
      institution: Math.round(parsedFlows.institution),
      retail: Math.round(parsedFlows.retail),
    };

    res.json({
      ok: true,
      symbol,
      date,
      flows,
      rawCount: Array.isArray(rawJson?.trades || rawJson?.items) ? (rawJson.trades || rawJson.items).length : undefined,
      _debug_used_url: usedUrl, // debug 필드 (필요시 제거)
    });
  } catch (e) {
    console.error("flow_err:", safeDetail(e?.message ?? e));
    const msg = e?.name === "AbortError" ? "timeout" : "internal";
    res.status(502).json({ ok: false, error: msg });
  }
});

// ── 주문은 금지(오발주 방지) ───────────────────────────────────
app.all("/kis/order", (_req, res) => res.status(403).json({ ok: false, error: "orders_disabled" }));

// ── 로컬 실행 지원 ─────────────────────────────────────────────
if (process.env.LOCAL_RUN === "1") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local server on http://localhost:${PORT}`));
}

// ── Vercel 기본 export ─────────────────────────────────────────
export default app;
