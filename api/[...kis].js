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
  const token = await getToken();
  const r = await fetch(u, {
    method: 'GET',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'accept': 'application/json',
      'authorization': `Bearer ${token}`,
      'appkey': process.env.KIS_APP_KEY,
      'appsecret': process.env.KIS_APP_SECRET,
      'tr_id': trid,
      'custtype': CUSTTYPE,
      // 추가 후보 (Apps Script와 더 유사하게)
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) KIS-Proxy/1.0',
      'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    },
  });
  const body = await r.text().catch(() => '');
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

// 서울 타임존 YYYYMMDD (오늘)
function todaySeoulYMD() {
  const nowSeoul = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  const y = nowSeoul.getFullYear();
  const m = String(nowSeoul.getMonth() + 1).padStart(2, '0');
  const d = String(nowSeoul.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
function ymdMinus(ymd, k) {
  const Y = Number(ymd.slice(0,4));
  const M = Number(ymd.slice(4,6)) - 1;
  const D = Number(ymd.slice(6,8));
  const dt = new Date(Date.UTC(Y, M, D));
  dt.setUTCDate(dt.getUTCDate() - k);
  return dt.toISOString().slice(0,10).replace(/-/g,'');
}

// 객체에서 대소문자 무시 키 찾기
function getCaseInsensitive(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  const target = String(key).toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === target) return obj[k];
  }
  return undefined;
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

// --- investor_raw: KIS 응답 원문을 그대로 반환(디버그용)
if (pathname === 'investor_raw') {
  const code = (url.searchParams.get('code') || '').trim();
  const date = (url.searchParams.get('date') || '').replace(/-/g,'').trim();
  if (!code) return res.status(400).json({ error: 'code is required' });
  const ymd = date || todaySeoulYMD();

  const qs = toQS({
    FID_COND_MRKT_DIV_CODE: 'J',
    FID_INPUT_ISCD: code,
    FID_INPUT_DATE_1: ymd,
    FID_ORG_ADJ_PRC: '',
    FID_ETC_CLS_CODE: '',
  });
  const u = `${BASE}${PATH.INVEST}?${qs}`;

  const { status, body } = await kisGET(u, TRID.INVEST);

  // Apps Script와 더 비슷하게 UA/Accept 등 헤더를 추가하고 싶다면 kisGET 내부에서 확장해도 OK
  return res.status(status).send(body);
}


    // --- series endpoint (Apps Script style): 한 번 호출 → 배열에서 상위 N개 추출
    // Usage: /api/series?code=005930&days=5&field=frgn_shnu_vol[&date=YYYYMMDD][&debug=1]
    if (pathname === 'series') {
      const code = (url.searchParams.get('code') || '').trim();
      const days = Math.min(Number(url.searchParams.get('days') || 5) || 5, 60); // 1~60
      const fieldRaw = (url.searchParams.get('field') || 'frgn_shnu_vol').trim();
      const overrideDate = (url.searchParams.get('date') || '').replace(/-/g,'').trim();
      const debug = url.searchParams.get('debug') === '1';
      if (!code) return res.status(400).json({ error: 'code is required' });

      // 약어 별칭
      const FIELD_ALIAS = {
        fb: 'frgn_shnu_vol',          // 외인매수량
        fs: 'frgn_seln_vol',          // 외인매도량
        fnb: 'frgn_ntby_tr_pbmn',     // 외인순매수금(대금)
        ob: 'orgn_shnu_vol',          // 기관매수량
        os: 'orgn_seln_vol',          // 기관매도량
        onb: 'orgn_ntby_tr_pbmn',     // 기관순매수금(대금)
      };
      const field = FIELD_ALIAS[fieldRaw.toLowerCase()] || fieldRaw;

      async function fetchAnyArray(ymd) {
        const qs = toQS({
          FID_COND_MRKT_DIV_CODE: 'J',
          FID_INPUT_ISCD: code,
          FID_INPUT_DATE_1: ymd,
          FID_ORG_ADJ_PRC: '',
          FID_ETC_CLS_CODE: '',
        });
        const u = `${BASE}${PATH.INVEST}?${qs}`;
        const { status, body } = await kisGET(u, TRID.INVEST);
        let js = null;
        try { js = JSON.parse(body || '{}'); } catch (_) { js = null; }
        // output2 → output → output1 순서로 배열 찾기
        let arr = [];
        if (js) {
          if (Array.isArray(js.output2)) arr = js.output2;
          else if (Array.isArray(js.output)) arr = js.output;
          else if (Array.isArray(js.output1)) arr = js.output1;
        }
        if (debug) {
          console.log('SERIES_ONECALL_URL', u);
          console.log('SERIES_ONECALL_STATUS', status);
          console.log('SERIES_ONECALL_LEN', Array.isArray(arr) ? arr.length : 0);
          try { console.log('SERIES_ONECALL_BODY', (body && body.slice) ? body.slice(0, 1200) : body); } catch {}
        }
        return { arr, raw: body };
      }

      // 1) 기준일 결정: override > 오늘(서울)
      let usedYmd = overrideDate || todaySeoulYMD();
      let { arr } = await fetchAnyArray(usedYmd);

      // 2) 없으면 최대 7일 과거 보정
      for (let i = 1; i <= 7 && (!arr || arr.length === 0); i++) {
        usedYmd = ymdMinus(usedYmd, 1);
        ({ arr } = await fetchAnyArray(usedYmd));
      }

      // 3) 최신(영업일) 내림차순 정렬
      const rows = Array.isArray(arr) ? arr.slice() : [];
      rows.sort((a,b)=> String((b && b.stck_bsop_date) || '').localeCompare(String((a && a.stck_bsop_date) || '')));

      // 4) 대소문자 무시로 필드 추출 + 숫자화
      const keyLower = field.toLowerCase();
      const toNum = (v) => {
        if (v == null || v === '') return null;
        const n = Number(String(v).replace(/[, ]+/g,''));
        return Number.isFinite(n) ? n : null;
        };
      const sliced = rows.slice(0, days);
      const series = sliced.map(row => {
        if (!row || typeof row !== 'object') return { date: '', status: 200, value: null };
        const date = String(row.stck_bsop_date || row.STCK_BSOP_DATE || '');
        // 필드 이름 대소문자 무시
        let rawVal = getCaseInsensitive(row, field);
        if (rawVal === undefined) {
          // 흔한 대문자 스키마 방어
          rawVal = getCaseInsensitive(row, keyLower.toUpperCase());
        }
        return { date, status: 200, value: toNum(rawVal) };
      });

      return res.status(200).json({ code, field, usedYmd, series });
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

/*** Web API 엔드포인트 (웹앱) ***/
/** 호출 예:
 *  https://script.google.com/macros/s/DEPLOY_ID/exec?op=series&code=005930&days=5&field=fb&key=YOUR_KEY
 *  field 별칭: fb=외인매수량, fs=외인매도량, fnb=외인순매수금, ob=기관매수량, os=기관매도량, onb=기관순매수금
 */
function doGet(e) {
  try {
    const p = e && e.parameter ? e.parameter : {};
    const op = (p.op || 'series').trim();            // 현재는 series만 지원
    const code = String(p.code || '').replace(/\D/g,'').padStart(6,'0');
    const days = Math.min(Math.max(1, parseInt(p.days || '5', 10) || 5), 60);
    const fieldRaw = (p.field || 'frgn_shnu_vol').trim();
    const apiKey = (p.key || '').trim();

    // 간단 키 체크(선택) — 원하시면 스크립트 속성에 저장한 키와 비교하도록 바꿔도 됩니다.
    var EXPECTED = 'heowoocheon'; // 필요 시 PropertiesService.getScriptProperties().getProperty('PROXY_API_KEY')
    if (EXPECTED && apiKey !== EXPECTED) {
      return _json_({ error: 'Unauthorized' }, 401);
    }

    if (!code || code === '000000') return _json_({ error: 'code is required' }, 400);

    // field 별칭
    const FIELD_ALIAS = {
      fb: 'frgn_shnu_vol',
      fs: 'frgn_seln_vol',
      fnb: 'frgn_ntby_tr_pbmn',
      ob: 'orgn_shnu_vol',
      os: 'orgn_seln_vol',
      onb: 'orgn_ntby_tr_pbmn',
    };
    const field = FIELD_ALIAS[String(fieldRaw).toLowerCase()] || fieldRaw;

    if (op === 'series') {
      // 오늘(서울) 기준일
      var base = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMdd');
      // KIS에서 해당 기준일 데이터 없을 수 있으니 _fetchInvestorDaily_가 알아서 7일 이내 보정
      var inv = _fetchInvestorDaily_(code, base) || {};
      var rows = Array.isArray(inv.output2) ? inv.output2.slice() : [];
      rows.sort(function(a,b){ return String(b.stck_bsop_date||'').localeCompare(String(a.stck_bsop_date||'')); });
      var cut = rows.slice(0, days);

      // 숫자 변환
      var toNum = function(v) {
        var s = (v == null ? '' : String(v)).replace(/[, ]+/g,'');
        var n = Number(s);
        return isFinite(n) ? n : null;
      };

      var series = cut.map(function(r){
        var date = String(r && r.stck_bsop_date || '');
        var val  = r ? r[field] : null;
        return { date: date, status: 200, value: toNum(val) };
      });

      return _json_({ code: code, field: field, series: series, base_ymd: inv._base_ymd || base });
    }

    return _json_({ error: 'Not Found' }, 404);
  } catch (err) {
    return _json_({ error: String(err && err.message ? err.message : err) }, 502);
  }
}

/** JSON 응답 유틸 */
function _json_(obj, status) {
  var out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out; // Apps Script는 상태코드 커스터마이즈가 제한됨(기본 200). 필요시 HTMLService로 우회 가능.
}
