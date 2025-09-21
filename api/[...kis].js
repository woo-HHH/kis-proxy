// --- New: series endpoint for extracting a field across recent days
// Usage: /api/series?code=005930&days=5&field=frgn_shnu_vol
if (pathname === 'series') {
  const code = url.searchParams.get('code') || '';
  const days = Math.min( Number(url.searchParams.get('days') || 5) || 5, 60 ); // max 60
  const field = url.searchParams.get('field') || 'frgn_shnu_vol';

  if (!code) return res.status(400).json({ error: 'code is required' });

  // 강건한 필드 탐색기 (case-insensitive, 배열/중첩 재귀, 숫자화 시도)
  function findFieldRobust(obj, key) {
    if (obj == null) return undefined;
    const target = (key || '').toString().toLowerCase();
    const seen = new Set();
    function dfs(x) {
      if (x == null) return undefined;
      if (typeof x !== 'object') return undefined;
      if (seen.has(x)) return undefined;
      seen.add(x);

      // direct case-insensitive key match
      for (const k of Object.keys(x)) {
        if (k.toLowerCase() === target) return x[k];
      }

      // if it's array-like, check array elements
      if (Array.isArray(x)) {
        for (const el of x) {
          if (el && typeof el === 'object') {
            const f = dfs(el);
            if (f !== undefined) return f;
          }
        }
      }

      // descend into children
      for (const k of Object.keys(x)) {
        try {
          const v = x[k];
          if (v && typeof v === 'object') {
            const f = dfs(v);
            if (f !== undefined) return f;
          }
        } catch (e) { /* ignore */ }
      }
      return undefined;
    }
    return dfs(obj);
  }

  const dates = makeDates(days);
  const out = [];

  for (const d of dates) {
    const u = `${BASE}${PATH.INVEST}?${toQS({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: d,
      FID_ORG_ADJ_PRC: '',
      FID_ETC_CLS_CODE: '',
    })}`;

    const { status, body } = await kisGET(u, TRID.INVEST);

    // **디버그: 업스트림 body도 남깁니다 (나중에 제거)**
    try {
      console.log('SERIES_UPSTREAM_URL', u);
      console.log('SERIES_UPSTREAM_STATUS', status);
      console.log('SERIES_UPSTREAM_BODY', (body && body.slice) ? body.slice(0, 4000) : body);
    } catch (e) { /* ignore */ }

    let parsed = null;
    try { parsed = JSON.parse(body || '{}'); } catch (e) { parsed = null; }

    // robust search
    let value = parsed ? findFieldRobust(parsed, field) : undefined;

    // 값이 문자열이고 숫자 형식(콤마 포함)이라면 숫자로 변환 시도
    if (value != null && typeof value === 'string') {
      const num = Number(value.replace(/[, ]+/g, ''));
      if (!Number.isNaN(num)) value = num;
    }

    out.push({ date: d, status, value: (value !== undefined ? value : null) });
  }

  return res.status(200).json({ code, field, series: out });
}
