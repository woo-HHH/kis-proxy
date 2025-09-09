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

// ── helpers ────────────────────────────────────────────────────
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

// ── 현재가 조회 (국내주식) READ-ONLY ───────────────────────────
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

// ── 주문은 금지(오발주 방지) ───────────────────────────────────
app.all("/kis/order", (_req, res) => res.status(403).json({ ok: false, error: "orders_disabled" }));

// ── 로컬 실행 지원 ─────────────────────────────────────────────
if (process.env.LOCAL_RUN === "1") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Local server on http://localhost:${PORT}`));
}

// ── Vercel 기본 export ─────────────────────────────────────────
export default app;
