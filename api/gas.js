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
    // 반드시 쿼리 없는 /exec 베이스 URL만!
    const BASE = process.env.GAS_EXEC_URL;
    if (!BASE) return res.status(500).json({ error: 'Missing GAS_EXEC_URL' });

    const url = new URL(req.url, 'http://local');
    const op    = (url.searchParams.get('op') || 'series').trim();
    const code  = (url.searchParams.get('code') || '').trim();
    const days  = (url.searchParams.get('days') || '').trim();
    const field = (url.searchParams.get('field') || '').trim();
    const key   = (url.searchParams.get('key') || '').trim();

    // Vercel 측 ping (프록시 자체 진단)
    if (op === 'ping') {
      return res.status(200).json({
        proxy: 'ok',
        has_GAS_EXEC_URL: !!BASE,
        forward_example: `${BASE}?op=series&code=005930&days=5&field=fb&key=YOUR_KEY`
      });
    }

    if (!code) return res.status(400).json({ error: 'code is required' });
    if (!key)  return res.status(400).json({ error: 'key is required' });

    // GAS /exec 로 그대로 전달 (302 follow)
    const tgt = new URL(BASE);
    tgt.searchParams.set('op', op);
    tgt.searchParams.set('code', code);
    if (days)  tgt.searchParams.set('days', days);
    if (field) tgt.searchParams.set('field', field);
    tgt.searchParams.set('key', key);

    const r = await fetch(tgt.toString(), { redirect: 'follow' });
    const text = await r.text().catch(() => '');

    res.status(r.status);
    res.setHeader('content-type', 'application/json; charset=utf-8');

    if (!ok(r)) {
      console.error('GAS_PROXY_UPSTREAM', r.status, text.slice(0, 500));
    }
    return res.send(text);
  } catch (e) {
    console.error('GAS_PROXY_ERROR', e && e.message ? e.message : e);
    return res.status(502).json({ error: 'Bad Gateway' });
  }
};
