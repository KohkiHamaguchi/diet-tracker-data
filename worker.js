// ───────────────────────────────────────────────────────────
// Diet log 書き込み中継 (Cloudflare Worker)
//
// 役割: アプリからのPOSTを受け取り、GitHubトークンを使って
//       リポジトリの data/diet.json を更新コミットする。
//       トークンはアプリ側には一切渡さない（ここに隠す）。
//
// 必要な Secrets（Worker の Settings → Variables → Secrets で登録）:
//   GITHUB_TOKEN   … リポジトリへの "Contents: Read and write" 権限を持つ
//                    fine-grained personal access token
//   SHARED_SECRET  … アプリと共有する任意の合言葉（雑な書き込みを弾く用）
//
// 下の OWNER / REPO は自分の値に書き換えてください。
// ───────────────────────────────────────────────────────────

const OWNER     = "KohkiHamaguchi";     // GitHub ユーザー名
const REPO      = "diet-tracker-data";  // データ用リポジトリ
const BRANCH    = "main";
const FILE_PATH = "data/diet.json";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// UTF-8 安全な base64 変換（日本語が壊れないように）
function toB64(str) {
  const bytes = encoder.encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function fromB64(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return decoder.decode(bytes);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "POST only" }, 405);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }

    if (!env.SHARED_SECRET || body.secret !== env.SHARED_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const date = body.date || new Date().toISOString().split("T")[0];
    const api  = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE_PATH}`;
    const ghHeaders = (extra = {}) => ({
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "diet-worker",
      "Accept": "application/vnd.github+json",
      ...extra,
    });

    // ── 現在の diet.json を読む（無ければ新規）──
    let data = { goal: 69, entries: {} };
    let sha;
    const get = await fetch(`${api}?ref=${BRANCH}`, { headers: ghHeaders() });
    if (get.status === 200) {
      const j = await get.json();
      sha = j.sha;
      try { data = JSON.parse(fromB64(j.content)); } catch { /* 壊れていたら初期値 */ }
      if (!data.entries) data.entries = {};
    } else if (get.status !== 404) {
      return json({ error: "github read failed", status: get.status }, 502);
    }

    // ── その日の記録に差分をマージ（アプリの保存ロジックと同じ考え方）──
    const e = data.entries[date] || {};
    if (typeof body.weight === "number" && body.weight >= 30 && body.weight <= 300) e.w = body.weight;
    if (typeof body.steps === "number"  && body.steps  >= 0  && body.steps  <= 99999) e.s = Math.round(body.steps);
    // 運動: 送られた配列でその日の types を置き換える（チェック解除も反映される）。
    if (Array.isArray(body.exercises)) {
      e.types = Array.from(new Set(body.exercises));
    }
    // 摂取kcalの直接指定（手入力の合計）。同じ date に food が来た場合は food 側で再計算される。
    if (typeof body.calories === "number" && body.calories >= 0 && body.calories <= 9999) {
      e.c = Math.round(body.calories);
    }
    // 食事: item.id で重複を弾いてから append（再送・通信断でも二重加算しない＝冪等）。
    if (body.food && Array.isArray(body.food.items) && body.food.items.length) {
      const existing = e.items || [];
      const existingIds = new Set(existing.map((x) => x.id).filter(Boolean));
      const add = body.food.items.filter((x) => !x.id || !existingIds.has(x.id));
      const items = [...existing, ...add];
      e.items = items;
      e.c = items.reduce((s, x) => s + (x.kcal || 0), 0);
    }
    if (typeof body.goal === "number" && body.goal >= 30 && body.goal <= 200) data.goal = body.goal;
    data.entries[date] = e;

    // ── 書き戻す ──
    const put = await fetch(api, {
      method: "PUT",
      headers: ghHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        message: `data: update ${date} via diet app`,
        content: toB64(JSON.stringify(data, null, 2) + "\n"),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.status !== 200 && put.status !== 201) {
      const detail = (await put.text()).slice(0, 200);
      return json({ error: "github write failed", status: put.status, detail }, 502);
    }

    return json({ ok: true, date, entry: e });
  },
};
