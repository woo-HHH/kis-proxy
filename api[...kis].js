// api/[...kis].js


async function kisGET(u, trid) {
const token = await getToken();
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
const text = await r.text();
return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
}


module.exports = async (req, res) => {
if (req.method === 'OPTIONS') { headersCORS(res); return res.status(204).end(); }
headersCORS(res);


try {
const apiKey = req.headers['x-api-key'];
if (!process.env.PROXY_API_KEY || apiKey !== process.env.PROXY_API_KEY) {
return res.status(401).json({ error: 'Unauthorized' });
}


// path routing: /api/price, /api/investor, /api/balance
const url = new URL(req.url, 'http://local'); // base dummy for parsing
const pathname = url.pathname.replace(/\/api\/?/, '');


if (pathname === 'health') return res.status(200).send('ok');


if (pathname === 'price') {
const code = url.searchParams.get('code') || '';
const mkt = url.searchParams.get('mkt') || 'J';
const u = `${BASE}${PATH.PRICE}?${toQS({ FID_COND_MRKT_DIV_CODE: mkt, FID_INPUT_ISCD: code })}`;
const r = await kisGET(u, TRID.PRICE);
return res.status(r.status).send(await r.text());
}


if (pathname === 'investor') {
const code = url.searchParams.get('code') || '';
const date = url.searchParams.get('date') || '';
const u = `${BASE}${PATH.INVEST}?${toQS({
FID_COND_MRKT_DIV_CODE: 'J',
FID_INPUT_ISCD: code,
FID_INPUT_DATE_1: date,
FID_ORG_ADJ_PRC: '',
FID_ETC_CLS_CODE: '',
})}`;
const r = await kisGET(u, TRID.INVEST);
return res.status(r.status).send(await r.text());
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
const r = await kisGET(u, TRID.BAL);
return res.status(r.status).send(await r.text());
}


return res.status(404).json({ error: 'Not Found' });
} catch (e) {
return res.status(502).json({ error: String(e && e.message ? e.message : e) });
}
};