// Vercel Serverless Function: POST /api/geocode
//
// 保存済みリストのCSVには緯度経度が入っていないため、店名から座標を引き当てる。
// Google Places API (New) の Text Search を使う。APIキーはここ（サーバー側）だけで使い、
// ブラウザには一切渡さない。
//
// リクエスト: { queries: ["店名1", "店名2", ...], bias?: { lat, lng, radiusKm } }
// レスポンス: { results: [{ query, lat, lng, matchedName } | { query, error }] }
//
// 必要な環境変数: GOOGLE_MAPS_API_KEY（Vercel の Project Settings > Environment Variables）

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const MAX_QUERIES = 25; // 1リクエストあたりの上限（関数のタイムアウト対策）
const CONCURRENCY = 5;

async function searchOne(query, apiKey, bias, detail) {
  const body = {
    textQuery: query,
    languageCode: "ja",
    regionCode: "JP",
    // 1件目を鵜呑みにせず、呼び出し側で選べるよう候補を複数返す
    // （料金はリクエスト単位なので、候補数は費用に影響しない）
    pageSize: 5,
  };
  if (bias && typeof bias.lat === "number" && typeof bias.lng === "number") {
    body.locationBias = {
      circle: {
        center: { latitude: bias.lat, longitude: bias.lng },
        radius: Math.min(Math.max((bias.radiusKm || 30) * 1000, 1), 50000),
      },
    };
  }

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      // 位置と名前だけを要求する（= Text Search Pro SKU。月5,000回まで無料）
      "X-Goog-FieldMask": detail
        ? "places.displayName,places.location,places.formattedAddress,places.id"
        : "places.displayName,places.location",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = "";
    try {
      const err = await res.json();
      detail = (err && err.error && err.error.message) || "";
    } catch (e) {
      /* ignore */
    }
    return { query, error: "Google API エラー (" + res.status + ") " + detail };
  }

  const data = await res.json();
  const places = data && Array.isArray(data.places) ? data.places : [];
  const candidates = places
    .filter((p) => p && p.location)
    .map((p) => ({
      lat: p.location.latitude,
      lng: p.location.longitude,
      name: (p.displayName && p.displayName.text) || "",
      ...(detail ? { address: p.formattedAddress || "", placeId: p.id || "" } : {}),
    }));

  if (!candidates.length) {
    return { query, error: "見つかりませんでした" };
  }
  return {
    query,
    candidates,
    // 古い呼び出し側との互換のため、1件目も従来どおり入れておく
    lat: candidates[0].lat,
    lng: candidates[0].lng,
    matchedName: candidates[0].name,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST のみ対応しています。" });
    return;
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error:
        "サーバーに GOOGLE_MAPS_API_KEY が設定されていません。Vercel の Environment Variables を確認し、設定後に再デプロイしてください。",
    });
    return;
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (e) {
      payload = null;
    }
  }
  // 住所だけ（Place Details Essentials。月1万件まで無料）
  if (payload && Array.isArray(payload.details)) {
    const ids = payload.details.filter((s) => typeof s === "string" && /^[A-Za-z0-9_-]{5,300}$/.test(s)).slice(0, 30);
    const addresses = {};
    await Promise.all(ids.map(async (id) => {
      try {
        const r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(id) + "?languageCode=ja", {
          headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "shortFormattedAddress,formattedAddress" },
        });
        if (!r.ok) return;
        const d = await r.json();
        addresses[id] = d.shortFormattedAddress || d.formattedAddress || "";
      } catch (e) { /* 取れなければ空のまま */ }
    }));
    res.status(200).json({ addresses });
    return;
  }

  const queries = payload && Array.isArray(payload.queries) ? payload.queries : null;
  if (!queries || !queries.length) {
    res.status(400).json({ error: "queries（店名の配列）が必要です。" });
    return;
  }
  if (queries.length > MAX_QUERIES) {
    res.status(400).json({ error: "1回あたり " + MAX_QUERIES + " 件までにしてください。" });
    return;
  }

  const bias = payload.bias || null;
  const results = new Array(queries.length);

  // 同時実行数を絞って順に処理する
  let cursor = 0;
  async function worker() {
    while (cursor < queries.length) {
      const i = cursor++;
      const q = String(queries[i] || "").trim();
      if (!q) {
        results[i] = { query: queries[i], error: "店名が空です" };
        continue;
      }
      try {
        results[i] = await searchOne(q, apiKey, bias, !!payload.detail);
      } catch (e) {
        results[i] = { query: q, error: "通信に失敗しました" };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker)
  );

  res.status(200).json({ results });
};
