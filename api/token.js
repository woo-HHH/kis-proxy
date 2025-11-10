export default async function handler(req, res) {
  try {
    const BASE_URL = "https://openapi.koreainvestment.com:9443";
    const response = await fetch(`${BASE_URL}/oauth2/tokenP`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        appkey: process.env.KIS_APP_KEY,
        appsecret: process.env.KIS_APP_SECRET
      })
    });

    const data = await response.json();
    if (!response.ok || !data.access_token) {
      return res.status(500).json({ error: "Token issue failed", detail: data });
    }

    res.status(200).json({
      access_token: data.access_token,
      expires_in: data.expires_in
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
