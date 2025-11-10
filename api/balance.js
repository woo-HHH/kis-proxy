let cachedToken = null;
let cachedExpireAt = 0; // ms

async function getAccessToken() {
  const now = Date.now();

  // 유효 토큰 있으면 재사용 (만료 60초 전까지)
  if (cachedToken && now < cachedExpireAt - 60 * 1000) {
    return cachedToken;
  }

  const BASE_URL = "https://openapi.koreainvestment.com:9443";

  const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.KIS_APP_KEY,
      appsecret: process.env.KIS_APP_SECRET
    })
  });

  const data = await res.json();

  if (!res.ok || !data.access_token) {
    throw new Error(`Token issue failed: ${JSON.stringify(data)}`);
  }

  const expiresInSec = parseInt(data.expires_in || "0", 10) || 60 * 60 * 24;
  cachedToken = data.access_token;
  cachedExpireAt = now + expiresInSec * 1000;

  return cachedToken;
}

export default async function handler(req, res) {
  const BASE_URL = "https://openapi.koreainvestment.com:9443";

  try {
    // 1️⃣ 토큰 (캐시 사용)
    const accessToken = await getAccessToken();

    // 2️⃣ TR ID (여기서 정확히 정의)
    const trId = process.env.KIS_TR_ID_VT || "VTTC8434R"; // 모의투자용. 실전이면 환경변수로 분리.

    // 3️⃣ 쿼리 파라미터
    const params = new URLSearchParams({
      CANO: process.env.KIS_CANO,
      ACNT_PRDT_CD: process.env.KIS_ACNT_PRDT_CD,
      AFHR_FLPR_YN: "N",
      OFL_YN: "N",
      INQR_DVSN: "02",
      UNPR_DVSN: "01",
      FUND_STTL_ICLD_YN: "N",
      FNCG_AMT_AUTO_RDPT_YN: "N",
      PRCS_DVSN: "01",
      CTX_AREA_FK100: "",
      CTX_AREA_NK100: ""
    });

    // 4️⃣ 잔고 조회 호출
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

    if (!balanceRes.ok || data.rt_cd !== "0") {
      // 원본 응답 같이 보내서 디버깅 쉽게
      return res.status(500).json({
        error: "Balance inquiry failed",
        detail: data
      });
    }

    // 5️⃣ 응답 가공
    const holdings = (data.output1 || []).map((s) => ({
      name: s.prdt_name,
      code: s.pdno,
      qty: s.hldg_qty,
      price: s.prpr
    }));

    const summarySrc =
      (Array.isArray(data.output2) && data.output2[0]) || data.output2 || {};

    const summary = {
      eval_amount: summarySrc.scts_evlu_amt,
      eval_profit: summarySrc.evlu_pfls_smtl_amt,
      total_eval: summarySrc.tot_evlu_amt
    };

    return res.status(200).json({
      status: "ok",
      holdings,
      summary
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
