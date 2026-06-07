# Diet Pipeline セットアップ手順

アプリ → Excel(GitHub) → HTML(GitHub) → アプリ のループを動かすための手順です。
**アカウント作成・トークン発行・シークレット登録は、セキュリティ上ご自身で行ってください**
（私の側では代行できません）。コードは全て用意済みです。

## 構成おさらい
```
アプリ ──POST──▶ Cloudflare Worker（トークンを隠し持つ）
                      └─ data/diet.json を更新コミット
                            └─ GitHub Actions が xlsx + html を自動生成
アプリ ◀──公開JSONをfetch（トークン不要）── data/diet.json
```

---

## 1. リポジトリを用意
1. GitHub で新規リポジトリ（例 `diet-tracker-data`）を作る。Public 推奨（Actions無料・JSON公開取得が楽）。
2. このフォルダの中身をそのまま push する。
   - `build.py`
   - `.github/workflows/build.yml`
   - `data/diet.json`（初期は `{"goal":69,"entries":{}}` でOK。サンプル入りでも可）
3. `worker.js` はリポジトリに入れなくて構いません（Worker側に貼る用）。

## 2. GitHub トークンを発行（ご自身で）
- GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate
- リポジトリは上記1つだけに限定
- 権限は **Contents: Read and write** のみ
- 発行された文字列は次の手順でWorkerに貼るだけ。**アプリやコードには絶対に書かない**こと。

## 3. Cloudflare Worker をデプロイ（ご自身で）
1. Cloudflare（無料）でWorkerを新規作成。
2. `worker.js` の中身を貼り付け、先頭の `OWNER` / `REPO` を自分の値に書き換える。
3. Worker の Settings → Variables and Secrets で **Secret** を2つ登録:
   - `GITHUB_TOKEN` … 手順2のトークン
   - `SHARED_SECRET` … 任意の合言葉（アプリ側にも同じ値を入れる）
4. デプロイ後に発行される URL（例 `https://diet-proxy.xxx.workers.dev`）を控える。

## 4. GitHub Pages を有効化（任意・ブラウザでも見たい場合）
- リポジトリ Settings → Pages → Source を `main` / root に。
- `https://<owner>.github.io/<repo>/index.html` で自動生成ビューアが見れる。

## 5. アプリ側を接続（実装済み・あなたは値を渡すだけ）
`DietTracker.jsx`(v3) に同期層は実装済みです。次の3つの定数（ファイル先頭）を実値に置き換えれば有効化されます。**未設定（プレースホルダ）の間は自動で同期をスキップし、v2 と同じローカル動作**になります。

```js
const PROXY_URL     = "https://diet-proxy.xxx.workers.dev";              // 手順3のWorker URL
const SHARED_SECRET = "（手順3の合言葉）";                                // 手順3で登録した値と一致させる
const DATA_URL      = "https://raw.githubusercontent.com/<owner>/<repo>/main/data/diet.json";  // 手順1のリポジトリ
```

私に **PROXY_URL / SHARED_SECRET / リポジトリの owner・repo** を渡してください。こちらで定数を埋めます。

実装済みの挙動:
- 各保存（体重・カロリー・歩数・目標体重）と「AIでまとめて記録」の成功時に、ローカル保存に加え Worker へ `POST`。
- 起動時に `DATA_URL?t=…`（キャッシュ回避）を `fetch` し、正本を表示に反映。`window.storage` はキャッシュ兼オフラインバッファ。
- オフライン/送信失敗時は未送信分を `window.storage` のキューに積み、オンライン復帰・次回起動で自動再送。
- 食事 item には id を付与し、Worker 側が id で重複排除しながら append するため、再送・通信断でも二重加算しない。
- ヘッダに「同期済み / 未送信◯件 / オフライン / ローカルのみ」を表示。

POST body（Worker が受ける契約）:
```json
{ "secret":"…", "date":"YYYY-MM-DD",
  "weight":78.6, "steps":9300, "exercises":["squat","plank"],
  "calories":1800, "food":{"items":[{"name":"牛丼","kcal":730,"id":"…"}]}, "goal":69 }
```
- `exercises` … その日の**全種目**を送る（Worker は置換。チェック解除も同期される）。
- `calories` … 手入力の合計を直接指定（同じ日に `food` が来たら items 合計で上書き）。
- 言及のない項目は省略可。返り値 `{ ok:true, date, entry }`。

※ SHARED_SECRET はあくまで雑な書き込み防止用。公開アプリに置く以上、機微情報は入れない前提です（書き込めるのは diet.json のみ・GitHubトークンは露出しない設計）。

---

## ローカルでの動作確認
```
pip install openpyxl
python build.py     # data/diet.json から diet.xlsx と index.html を生成
```
