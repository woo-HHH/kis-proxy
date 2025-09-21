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

    if (pathname === 'investor') {
      const code = url.searchParams.get('code') || '';
      // 날짜 포맷 정규화: 허용되는 형식(YYYYMMDD)으로 자동 변환
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

      // --- Debug logs: 업스트림 URL / 상태 / 바디 일부를 남깁니다.
      // 나중에 문제 해결되면 이 로그는 제거하세요 (민감정보 노출 주의)
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
