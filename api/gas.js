// api/gas.js
// GAS WebApp proxy for GPTs (handles 302 follow, stable params pass-through)

function ok(r) { return r.status >= 200 && r.status < 300; }
function headersCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { headersCORS(res); return res.status(204).end(); }
  headersCORS(res);

  try {
    // 1) 반드시 /exec ‘베이스’ URL만 환경변수에 넣어둡니다 (쿼리 없이)
    //    예: https://script.google.com/macros/s/AKfycbzCnWwico_cqQzr2NnSDExG0VklGfq7oym4idt0l0uXB-eRzhl9FhX87A9lWzFEiCOk/exec
    const BASE = process.env.GAS_EXEC_URL;
    if (!BASE) return res.status(500).json({ error: 'Missing GAS_EXEC_URL' });

    const url = new URL(req.url, 'http://local');
    const op    = url.searchParams.get('op')    || 'series';
    const code  = url.searchParams.get('code')  || '';
    const days  = url.searchParams.get('days')  || '';
    const field = url.searchParams.get('field') || '';
    const key   = url.searchParams.get('key')   || '';

    if (!code) return res.status(400).json({ error: 'code is required' });
    if (!key)  return res.status(400).json({ error: 'key is required' });

    // 2) GAS /exec 로 그대로 전달 (리다이렉트 follow)
    const tgt = new URL(BASE);
    tgt.searchParams.set('op', op);
    tgt.searchParams.set('code', code);
    if (days)  tgt.searchParams.set('days', days);
    if (field) tgt.searchParams.set('field', field);
    tgt.searchParams.set('key', key);

    const r = await fetch(tgt.toString(), { redirect: 'follow' });
    const text = await r.text().catch(()=>'');

    // 3) 그대로 전달
    res.status(r.status);
    // GAS는 JSON을 text/plain으로 줄 때도 있어 content-type 강제
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (!ok(r)) {
      // 문제 파악용 로그(원하면 제거 가능)
      console.error('GAS_PROXY_UPSTREAM', r.status, text.slice(0, 500));
    }
    return res.send(text);
  } catch (e) {
    console.error('GAS_PROXY_ERROR', e && e.message ? e.message : e);
    return res.status(502).json({ error: 'Bad Gateway' });
  }
};
