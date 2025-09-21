// api/[...kis].js
// Vercel Serverless Function (Node.js) — KIS LIVE Proxy (stabilized)

const BASE = 'https://openapi.koreainvestment.com:9443';
const PATH = {
  TOKEN: '/oauth2/tokenP',
  PRICE: '/uapi/domestic-stock/v1/quotations/inquire-price',
  INVEST: '/uapi/domestic-stock/v1/quotations/investor-trade-by-stock-daily',
  BAL: '/uapi/domestic-stock/v1/trading/inquire-balance',
};
const TRID = {
  PRICE: 'FHKST01010100',
  INVEST: 'FHPTJ04160001',
  BAL: 'TTTC8434R',
};
const CUSTTYPE = 'P';

let cachedToken = null; // { token: string, exp: number(ms) }

function ok(res) { return res.status >= 200 && res.status < 300; }
function headersCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}
function toQS(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
function assertEnv() {
  if (!process.env.KIS_APP_KEY || !process.env.KIS_APP_SECRET) {
    throw new Error('Missing KIS_APP_KEY / KIS_APP_SECRET');
  }
  if (!process.env.PROXY_API_KEY) {
    throw new Error('Missing PROXY_API_KEY');
  }
}

async function getToken() {
  const now = Date.now();
  if (cachedToken && now < cachedToken.exp - 60_000) return cachedToken.token;

  const body = JSON.stringify({
    grant_type: 'client_credentials',
    appkey: process.env.KIS_APP_KEY,
    appsecret: process.env.KIS_APP_SECRET,
  });

  const r = await fetch(BASE + PATH.TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
    body,
  });
  const text = await r.text().catch(() => '');
  if (!ok(r)) {
    console.error('TOKEN_UPSTREAM_ERROR', r.status, text);
    throw new Error(`TOKEN ${r.status}: ${text.slice(0, 200)}`);
  }

  let js;
  try { js = JSON.parse(text || '{}'); } catch (e) {
    console.error('TOKEN_JSON_ERROR', e, text);
    throw new Error('TOKEN parse error');
  }

  const token = js.access_token;
  if (!token) throw new Error('TOKEN missing access_token');

  let exp = Date.now() + 9 * 60 * 1000;
  if (js.access_token_token_expired) {
    const t = new Date(js.access_token_token_expired).getTime();
    if (Number.isFinite(t)) exp = t;
  }
  cachedToken = { token, exp };
  return token;
}

async function kisGET(u, trid) {
  const token = await getToken(); // 예외는 상위 try/catch에서 처리
  const r = await fetch(u, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET,
      tr_id: trid,
      custtype: CUSTTYPE,
    },
  });
  const body = await r.text().catch((e) => {
    console.error('READ_BODY_ERROR', e);
    return '';
  });
  if (!ok(r)) console.error('UPSTREAM_ERROR', r.status, body);
  return { status: r.status, body };
}

// 날짜 포맷 YYYYMMDD 생성 (UTC 기준으로 단순 역산)
function makeDates(days) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    const s = d.toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
    dates.push(s);
  }
  return dates;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { headersCORS(res); return res.status(204).end(); }
  headersCORS(res);

  try {
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname.replace(/^\/api\/?/, '');

    // 1) 헬스체크는 무인증
    if (pathname === 'health') return res.status(200).send('ok');

    // 2) API Key 검사
    const apiKey = (req.headers['x-api-key'] || '').toString();
    if (!process.env.PROXY_API_KEY || apiKey !== process.env.PROXY_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // 3) 환경변수 필수 검사
    assertEnv();

    // 4) 라우팅
    if (pathname === 'price') {
      const code = url.searchParams.get('code') || '';
      const mkt  = url.searchParams.get('mkt') || 'J';
      const u = `${BASE}${PATH.PRICE}?${toQS({ FID_COND_MRKT_DIV_CODE: mkt, FID_INPUT_ISCD: code })}`;
      const { status, body } = await kisGET(u, TRID.PRICE);
      return res.status(status).send(body);
    }

    // --- series endpoint for extracting a field across recent days
    // Usage: /api/series?code=005930&days=5&field=frgn_shnu_vol
    if (pathname === 'series') {
      const code = url.searchParams.get('code') || '';
      const days = Math.min(Number(url.searchParams.get('days') || 5) || 5, 60); // max 60
      const fieldRaw = (url.searchParams.get('field') || 'frgn_shnu_vol').trim();

      if (!code) return res.status(400).json({ error: 'code is required' });

      // 약어 별칭 지원
      const FIELD_ALIAS = {
        fb: 'frgn_shnu_vol',          // 외인매수량
        fs: 'frgn_seln_vol',          // 외인매도량
        fnb: 'frgn_ntby_tr_pbmn',     // 외인순매수금(대금)
        ob: 'orgn_shnu_vol',          // 기관매수량
        os: 'orgn_seln_vol',          // 기관매도량
        onb: 'orgn_ntby_tr_pbmn',     // 기관순매수금(대금)
      };
      const field = FIELD_ALIAS[fieldRaw.toLowerCase()] || fieldRaw;

      // 견고한 필드 탐색기 (대소문자 무시, 배열/중첩 탐색, 숫자 문자열 변환)
      function findFieldRobust(obj, key) {
        if (obj == null) return undefined;
        const target = String(key).toLowerCase();
        const seen = new Set();
        function dfs(x) {
          if (!x || typeof x !== 'object' || seen.has(x)) return undefined;
          seen.add(x);
          for (const k of Object.keys(x)) {
            if (k.toLowerCase() === target) return x[k];
          }
          if (Array.isArray(x)) {
            for (const el of x) {
              const f = dfs(el);
              if (f !== undefined) return f;
            }
          }
          for (const k of Object.keys(x)) {
            const f = dfs(x[k]);
            if (f !== undefined) return f;
          }
          return undefined;
        }
        return dfs(obj);
      }

      // YYYYMMDD 리스트 (오늘부터 역순)
      const dates = makeDates(days);
      const out = [];

      for (const d0 of dates) {
        // d0부터 시작 → 빈 응답이면 최대 7일 이전으로 보정(주말/휴일 스킵)
        let attemptDate = d0;
        let attempts = 0;
        let finalStatus = 0;
        let finalValue = null;

        while (attempts < 7) {
          const u = `${BASE}${PATH.INVEST}?${toQS({
            FID_COND_MRKT_DIV_CODE: 'J',
            FID_INPUT_ISCD: code,
            FID_INPUT_DATE_1: attemptDate,
            FID_ORG_ADJ_PRC: '',
            FID_ETC_CLS_CODE: '',
          })}`;

          const { status, body } = await kisGET(u, TRID.INVEST);
          finalStatus = status;

          // (필요 시) 디버그 로그 — 문제 해결 후 제거 권장
          console.log('SERIES_UPSTREAM_URL', u);
          console.log('SERIES_UPSTREAM_STATUS', status);
          console.log('SERIES_UPSTREAM_BODY', (body && body.slice) ? body.slice(0, 2000) : body);

          // 파싱 (예외만 try-catch)
          let parsed = null;
          try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = null; }

          // 비거래일/데이터 없음 패턴
          const looksEmpty =
            parsed && typeof parsed === 'object' &&
            Object.keys(parsed).length === 3 &&
            parsed.rt_cd === '' && parsed.msg_cd === '' && parsed.msg1 === '';

          // 값 추출
          let value = null;
          if (!looksEmpty && parsed) {
            value = findFieldRobust(parsed, field);
            if (value != null && typeof value === 'string') {
              const num = Number(value.replace(/[, ]+/g, ''));
              if (!Number.isNaN(num)) value = num;
            }
          }

          if (!looksEmpty && value != null) {
            finalValue = value;
            break; // 성공
          }

          // 실패 → 이전 날짜로 -1일
          const y = Number(attemptDate.slice(0, 4));
          const m = Number(attemptDate.slice(4, 6)) - 1;
          const d = Number(attemptDate.slice(6, 8));
          const prev = new Date(Date.UTC(y, m, d));
          prev.setUTCDate(prev.getUTCDate() - 1);
          attemptDate = prev.toISOString().slice(0, 10).replace(/-/g, '');

          attempts++;
        }

        out.push({ date: d0, status: finalStatus, value: finalValue });
      }

      return res.status(200).json({ code, field, series: out });
    }

    if (pathname === 'investor') {
      const code = url.searchParams.get('code') || '';
      const rawDate = url.searchParams.get('date') || '';
      const date = rawDate.replace(/-/g, '');
      const u = `${BASE}${PATH.INVEST}?${toQS({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: date,
        FID_ORG_ADJ_PRC: '',
        FID_ETC_CLS_CODE: '',
      })}`;

      const { status, body } = await kisGET(u, TRID.INVEST);

      try {
        console.log('INVEST_UPSTREAM_URL', u);
        console.log('INVEST_UPSTREAM_STATUS', status);
        console.log('INVEST_UPSTREAM_BODY', (body && body.slice) ? body.slice(0, 1000) : body);
      } catch (e) {
        console.error('INVEST_LOG_ERROR', e && e.message ? e.message : e);
      }

      return res.status(status).send(body);
    }

    if (pathname === 'balance') {
      const q = {
        CANO: url.searchParams.get('cano') || '',
        ACNT_PRDT_CD: url.searchParams.get('prdt') || '',
        AFHR_FLPR_YN: url.searchParams.get('afhr') || 'N',
        OFL_YN: '',
        INQR_DVSN: url.searchParams.get('inqr') || '02',
        UNPR_DVSN: url.searchParams.get('unpr') || '01',
        FUND_STTL_ICLD_YN: url.searchParams.get('fund') || 'N',
        FNCG_AMT_AUTO_RDPT_YN: url.searchParams.get('auto') || 'N',
        PRCS_DVSN: url.searchParams.get('prcs') || '00',
        CTX_AREA_FK100: url.searchParams.get('fk') || '',
        CTX_AREA_NK100: url.searchParams.get('nk') || '',
      };
      const u = `${BASE}${PATH.BAL}?${toQS(q)}`;
      const { status, body } = await kisGET(u, TRID.BAL);
      return res.status(status).send(body);
    }

    return res.status(404).json({ error: 'Not Found' });
  } catch (e) {
    console.error('SERVER_ERROR', e);
    return res.status(502).json({ error: String(e && e.message ? e.message : e) });
  }
};
