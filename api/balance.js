export default async function handler(req, res) {
  const BASE_URL = "https://openapi.koreainvestment.com:9443";

  try {
    // 1) 토큰 발급
    const tokenRes = await fetch(`${BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(500).json({ error: "Token issue failed", detail: tokenData });
    }

    // 2) 잔고 조회
const params = new URLSearchParams({
  CANO: process.env.KIS_CANO,
  ACNT_PRDT_CD: process.env.KIS_ACNT_PRDT_CD,
  AFHR_FLPR_YN: "N",
  OFL_YN: "N",              // 🔴 누락되어 있던 필수 파라미터 추가
  INQR_DVSN: "02",
  UNPR_DVSN: "01",
  FUND_STTL_ICLD_YN: "N",
  FNCG_AMT_AUTO_RDPT_YN: "N",
  PRCS_DVSN: "01",
  CTX_AREA_FK100: "",
  CTX_AREA_NK100: ""
});


    const balanceRes = await fetch(
      `${BASE_URL}/uapi/domestic-stock/v1/trading/inquire-balance?${params.toString()}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          authorization: `Bearer ${accessToken}`,
          appkey: process.env.KIS_APP_KEY,
          appsecret: process.env.KIS_APP_SECRET,
          tr_id: trId,
          custtype: "P"
        }
      }
    );

    const data = await balanceRes.json();
    if (!balanceRes.ok) {
      return res.status(500).json({ error: "Balance inquiry failed", detail: data });
    }

    const stocks = (data.output1 || []).map((s) => ({
      name: s.prdt_name,
      code: s.pdno,
      qty: s.hldg_qty,
      price: s.prpr
    }));

    const summary = (data.output2 && data.output2[0]) || {};

    res.status(200).json({
      status: "ok",
      holdings: stocks,
      summary: {
        eval_amount: summary.scts_evlu_amt,
        eval_profit: summary.evlu_pfls_smtl_amt,
        total_eval: summary.tot_evlu_amt
      },
      raw: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
