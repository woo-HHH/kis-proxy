// api/gas.js
// GAS WebApp proxy (series endpoint)

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    // 1) 실행 환경 변수: 쿼리 없는 /exec “베이스” 만!
    const BASE = process.env.GAS_EXEC_URL
      || 'https://script.google.com/macros/s/AKfycbzCnWwico_cqQzr2NnSDExG0VklGfq7oym4idt0l0uXB-eRzhl9FhX87A9lWzFEiCOk/exec';

    // 2) 입력 파라미터 + 기본값/검증
    const q = req.query || {};
    const code = String(q.code || '').replace(/\D/g, '').padStart(6, '0');
    const key  = String(q.key  || '').trim();
    let   days = Number(q.days ?? 5);
    if (!Number.isFinite(days) || days < 1) days = 5;
    if (days > 60) days = 60;

    const FIELD_ALIAS = {
      fb:  'frgn_shnu_vol',
      fs:  'frgn_seln_vol',
      fnb: 'frgn_ntby_tr_pbmn',
      ob:  'orgn_shnu_vol',
      os:  'orgn_seln_vol',
      onb: 'orgn_ntby_tr_pbmn',
    };
    const rawField = String(q.field || 'fb').trim().toLowerCase();
    const field = FIELD_ALIAS[rawField] || rawField; // 별칭 또는 원문

    if (!code || code === '000000') {
      return res.status(400).json({ error: 'code is required' });
    }
    if (!key) {
      return res.status(400).json({ error: 'key is required' });
    }

    // 3) GAS 호출 URL 구성 (리다이렉트 follow는 fetch 기본 동작)
    const u = new URL(BASE);
    u.searchParams.set('op', 'series');
    u.searchParams.set('code', code);
    u.searchParams.set('days', String(days));
    // note: GAS는 별칭도 처리 가능하지만, 서버에선 매핑된 키를 전달
    u.searchParams.set('field', field);
    u.searchParams.set('key', key);

    const upstream = await fetch(u.toString(), { redirect: 'follow' });
    const text = await upstream.text().catch(() => '');

    // 4) 응답 그대로 전달 (가능하면 JSON으로, 아니면 텍스트)
    res.status(upstream.status);
    // GAS가 text/plain으로 돌려줄 때도 있으니 강제 JSON 헤더
    res.setHeader('content-type', 'application/json; charset=utf-8');

    // JSON 파싱 시도
    try {
      const json = text ? JSON.parse(text) : {};
      return res.send(JSON.stringify(json));
    } catch {
      // JSON 아님 → 그냥 원문 전달
      return res.send(text || '');
    }
  } catch (err) {
    return res.status(502).json({ error: (err && err.message) || 'Bad Gateway' });
  }
}
