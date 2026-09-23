// Vercel Serverless Function: /api/sync
//
// ふたりで同じピンを見るための、小さな保管場所。
// 「合言葉（スペースコード）」ごとに、ピンと写真を置いておくだけ。
// 保存先は Upstash Redis（Vercel の Marketplace からつなぐと環境変数が自動で入る）。
//
//   GET  /api/sync?ping=1                      → {ok, storage:true/false}
//   GET  /api/sync?space=CODE&since=0          → {now, pins:[...], total}
//   GET  /api/sync?space=CODE&photos=id1,id2   → {photos:{id:dataUrl|null}}
//   POST /api/sync  {space, pins:[...], photos:{id:dataUrl|null}}
//                                              → {now, saved, skipped}
//
// 後から来た書き込みを採用する（last write wins）。時刻はサーバーで打つので、
// 2台のスマホの時計がずれていても順番が狂わない。

const crypto = require("crypto");

const MAX_PINS_PER_REQUEST = 400;
const MAX_PHOTO_BYTES = 400 * 1024; // 1枚あたり（320pxのJPEGなら十分）
const MAX_TOTAL_PINS = 5000;

/* ---------- 保存先（Upstash Redis の REST API） ---------- */
// 環境変数の名前は、つなぎ方によって KV_REST_API_URL だったり
// UPSTASH_REDIS_REST_URL だったりする。どれでも拾えるようにしておく。
function redisConfig() {
  const env = process.env;
  const direct = [
    ["KV_REST_API_URL", "KV_REST_API_TOKEN"],
    ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
    ["REDIS_REST_URL", "REDIS_REST_TOKEN"],
  ];
  for (const [u, t] of direct) {
    if (env[u] && env[t]) return { url: env[u].replace(/\/+$/, ""), token: env[t] };
  }
  // 接頭辞つき（例：MICHIKUSA_KV_REST_API_URL）でも動くように探す
  for (const key of Object.keys(env)) {
    if (/REST_API_URL$|REDIS_REST_URL$/.test(key) && env[key]) {
      const tokenKey = key.replace(/URL$/, "TOKEN");
      if (env[tokenKey]) return { url: env[key].replace(/\/+$/, ""), token: env[tokenKey] };
    }
  }
  return null;
}

async function redis(commands) {
  const cfg = redisConfig();
  if (!cfg) throw new Error("NO_STORAGE");
  const single = !Array.isArray(commands[0]);
  const res = await fetch(cfg.url + (single ? "" : "/pipeline"), {
    method: "POST",
    headers: { Authorization: "Bearer " + cfg.token, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("保管場所に接続できませんでした (" + res.status + ") " + t.slice(0, 200));
  }
  const data = await res.json();
  if (single) {
    if (data && data.error) throw new Error(String(data.error));
    return data.result;
  }
  return data.map((d) => {
    if (d && d.error) throw new Error(String(d.error));
    return d.result;
  });
}

/* ---------- 合言葉 ---------- */
// 合言葉そのものは保存しない。ハッシュにしてから鍵の名前にする。
function keyFor(space) {
  const h = crypto.createHash("sha256").update("michikusa:" + space).digest("hex").slice(0, 32);
  return "mk:" + h;
}
function validSpace(space) {
  return typeof space === "string" && /^[A-Z0-9-]{10,48}$/.test(space);
}

/* ---------- ピンの整形（送られてきた値をそのまま信用しない） ---------- */
const CATS = ["eat", "cafe", "sight", "shop", "other"];
function cleanPin(p) {
  if (!p || typeof p !== "object") return null;
  const id = String(p.id || "").slice(0, 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  if (p.deleted) return { id: id, deleted: true };
  const name = String(p.name == null ? "" : p.name).slice(0, 200).trim();
  if (!name) return null;
  const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);
  return {
    id: id,
    name: name,
    cat: CATS.indexOf(p.cat) !== -1 ? p.cat : "other",
    lat: num(p.lat),
    lng: num(p.lng),
    budget: num(p.budget),
    note: String(p.note == null ? "" : p.note).slice(0, 500),
    url: /^https?:\/\//i.test(p.url || "") ? String(p.url).slice(0, 500) : "",
    listName: String(p.listName == null ? "" : p.listName).slice(0, 100),
    needsCheck: !!p.needsCheck,
    checkLevel: p.checkLevel === "strong" || p.checkLevel === "weak" || p.checkLevel === "ok" ? p.checkLevel : "",
    checkReason: String(p.checkReason == null ? "" : p.checkReason).slice(0, 300),
    matchedName: String(p.matchedName == null ? "" : p.matchedName).slice(0, 200),
    placeId: String(p.placeId == null ? "" : p.placeId).replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 200),
    photoV: String(p.photoV == null ? "" : p.photoV).slice(0, 32),
    kind: /^[a-z]{1,12}$/.test(p.kind || "") ? p.kind : "",
  };
}

function sendJson(res, code, obj) {
  res.status(code).json(obj);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // 保管場所がつながっているかの確認だけは、合言葉なしでできる
  if (req.method === "GET" && req.query && req.query.ping) {
    return sendJson(res, 200, { ok: true, storage: !!redisConfig() });
  }

  if (!redisConfig()) {
    return sendJson(res, 503, {
      error:
        "サーバーに保管場所（Redis）がつながっていません。Vercel の Storage から Upstash Redis を接続し、再デプロイしてください。",
      code: "NO_STORAGE",
    });
  }

  try {
    if (req.method === "GET") {
      const space = String((req.query && req.query.space) || "").toUpperCase();
      if (!validSpace(space)) return sendJson(res, 400, { error: "合言葉が正しくありません。" });
      const key = keyFor(space);

      // 写真だけ取りに来た場合
      if (req.query.photos) {
        const ids = String(req.query.photos).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 30);
        if (!ids.length) return sendJson(res, 200, { photos: {} });
        const vals = await redis(["HMGET", key + ":photos"].concat(ids));
        const photos = {};
        ids.forEach((id, i) => { photos[id] = (vals && vals[i]) || null; });
        return sendJson(res, 200, { photos: photos });
      }

      const since = Number(req.query.since || 0) || 0;
      const now = Date.now();
      const flat = await redis(["HGETALL", key + ":pins"]);
      const pins = [];
      let total = 0;
      if (Array.isArray(flat)) {
        for (let i = 0; i < flat.length; i += 2) {
          let obj = null;
          try { obj = JSON.parse(flat[i + 1]); } catch (e) { continue; }
          if (!obj) continue;
          total++;
          if ((obj.u || 0) > since) pins.push(obj);
        }
      }
      return sendJson(res, 200, { now: now, pins: pins, total: total });
    }

    if (req.method === "POST") {
      let payload = req.body;
      if (typeof payload === "string") {
        try { payload = JSON.parse(payload); } catch (e) { payload = null; }
      }
      if (!payload) return sendJson(res, 400, { error: "内容を読み取れませんでした。" });
      const space = String(payload.space || "").toUpperCase();
      if (!validSpace(space)) return sendJson(res, 400, { error: "合言葉が正しくありません。" });
      const key = keyFor(space);

      const incoming = Array.isArray(payload.pins) ? payload.pins : [];
      if (incoming.length > MAX_PINS_PER_REQUEST) {
        return sendJson(res, 400, { error: "一度に送れるのは " + MAX_PINS_PER_REQUEST + " 件までです。" });
      }
      const cleaned = incoming.map(cleanPin).filter(Boolean);
      const now = Date.now();
      let saved = 0;

      if (cleaned.length) {
        const ids = cleaned.map((p) => p.id);
        const existingRaw = await redis(["HMGET", key + ":pins"].concat(ids));
        const args = [];
        cleaned.forEach((p, i) => {
          let cur = null;
          try { cur = existingRaw && existingRaw[i] ? JSON.parse(existingRaw[i]) : null; } catch (e) { cur = null; }
          // 後から届いたものを採用する（サーバーの時計で判定）
          p.u = now;
          if (cur && (cur.u || 0) > now) return;
          args.push(p.id, JSON.stringify(p));
          saved++;
        });
        if (args.length) {
          const count = await redis(["HLEN", key + ":pins"]);
          if ((count || 0) + args.length / 2 > MAX_TOTAL_PINS) {
            return sendJson(res, 400, { error: "ピンが多すぎます（上限 " + MAX_TOTAL_PINS + " 件）。" });
          }
          await redis([["HSET", key + ":pins"].concat(args), ["EXPIRE", key + ":pins", 60 * 60 * 24 * 365]]);
        }
      }

      // 写真（null なら削除）
      const photos = payload.photos && typeof payload.photos === "object" ? payload.photos : null;
      if (photos) {
        const setArgs = [];
        const delArgs = [];
        Object.keys(photos).slice(0, 60).forEach((id) => {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
          const v = photos[id];
          if (v == null) { delArgs.push(id); return; }
          if (typeof v !== "string" || v.indexOf("data:image/") !== 0 || v.length > MAX_PHOTO_BYTES) return;
          setArgs.push(id, v);
        });
        const cmds = [];
        if (setArgs.length) cmds.push(["HSET", key + ":photos"].concat(setArgs));
        if (delArgs.length) cmds.push(["HDEL", key + ":photos"].concat(delArgs));
        if (cmds.length) {
          cmds.push(["EXPIRE", key + ":photos", 60 * 60 * 24 * 365]);
          await redis(cmds);
        }
      }

      return sendJson(res, 200, { now: now, saved: saved });
    }

    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { error: "GET か POST を使ってください。" });
  } catch (err) {
    const msg = (err && err.message) || "不明なエラー";
    if (msg === "NO_STORAGE") {
      return sendJson(res, 503, { error: "保管場所がつながっていません。", code: "NO_STORAGE" });
    }
    return sendJson(res, 500, { error: msg.slice(0, 300) });
  }
};
