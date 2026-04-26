# Watanabe Group — site source

無料の構成（GitHub Pages + Cloudflare Worker + D1）で運用する、
渡辺研究室のサポートサイトと掲示板のソースコードです。

## ディレクトリ構成

```
website/
├── index.html               トップページ
├── members/
│   └── watanabe.html        プロフィール
├── books/
│   ├── ca.html              「複素関数論入門」サポート + 掲示板
│   └── am.html              「解析力学」サポート + 掲示板
├── board/
│   └── admin.html           管理者用モデレーション画面
├── assets/
│   ├── style.css            共通スタイル
│   ├── board.js             掲示板クライアント
│   └── config.js            API URL / Turnstile site key を書き込む場所
└── worker/                  Cloudflare Worker（バックエンド）
    ├── src/index.js
    ├── schema.sql
    ├── wrangler.toml
    └── package.json
```

## 全体像

- **静的サイト**（HTML/CSS/JS）は **GitHub Pages** で配信。
- **掲示板の投稿・取得 API** は **Cloudflare Worker** で動かす。データは Cloudflare の SQLite (**D1**) に保存。
- **数式表示**は **KaTeX**（CDN 経由でブラウザに読み込む）。
- **スパム対策**は **Cloudflare Turnstile**（不可視 CAPTCHA）+ IP ベースのレート制限 + ハニーポット。
- 訪問者はアカウント登録不要。投稿は `ハンドルネーム` + `質問内容` のみ。

---

## デプロイ手順

### 0. 必要なアカウント（先生のみ）

- [GitHub](https://github.com/signup) — 無料、メールのみ
- [Cloudflare](https://dash.cloudflare.com/sign-up) — 無料、メールのみ

### 1. GitHub にリポジトリを作って中身をプッシュ

ローカル（このディレクトリ）で:

```bash
cd ~/Dropbox/website
git init
git add .
git commit -m "Initial site"
# GitHub 上で空のリポジトリ（例 watanabegroup-site）を作ってから:
git branch -M main
git remote add origin https://github.com/<your-github-username>/<repo-name>.git
git push -u origin main
```

GitHub のリポジトリ画面 → **Settings → Pages** で:

- **Source**: `Deploy from a branch`
- **Branch**: `main` / `/ (root)` を選択 → Save

数分で `https://<your-github-username>.github.io/<repo-name>/` でサイトが公開されます。
（ユーザーサイト形式 `https://<your-github-username>.github.io/` にしたい場合は、リポジトリ名を `<your-github-username>.github.io` にしてください。）

### 2. Cloudflare Worker と D1 をセットアップ

ターミナルで:

```bash
cd worker
npm install
npx wrangler login                          # ブラウザで Cloudflare にログイン
npx wrangler d1 create watanabe-board       # D1 データベースを作成
```

最後のコマンドで返ってくる `database_id` を `worker/wrangler.toml` の
`REPLACE-WITH-D1-DATABASE-ID` の部分に貼り付けてください。

データベースのテーブルを作成:

```bash
npm run db:init:local       # ローカル開発用
npm run db:init:remote      # 本番（クラウド）用
```

過去の Google Forms の回答（`ca.xlsx` / `ma.xlsx` から生成）を投入:

```bash
npx wrangler d1 execute watanabe-board --remote --file=./seed.sql
# ローカルに入れる場合は --local
```

`seed.sql` には 171 件（複素関数論 18 件・解析力学 153 件）の過去投稿が含まれます。
複数回流すと重複するので、再実行する前に
`DELETE FROM posts WHERE ip_hash = 'archive-import';` で古い投入分を消してください。

シークレット（パスワード等）を設定:

```bash
npx wrangler secret put ADMIN_PASSWORD
# → 管理画面で使うパスワードを入力（例: 強めのランダム文字列）

npx wrangler secret put IP_HASH_SALT
# → ランダム文字列を入力（`openssl rand -hex 32` で生成可）

# Turnstile を使う場合のみ（後述）:
npx wrangler secret put TURNSTILE_SECRET_KEY
```

`wrangler.toml` の `ALLOWED_ORIGINS` を、GitHub Pages の URL に書き換え:

```toml
[vars]
ALLOWED_ORIGINS = "https://<your-github-username>.github.io"
```

デプロイ:

```bash
npm run deploy
```

`https://watanabe-board.<your-cf-subdomain>.workers.dev` のような URL が返ります。

### 3. Cloudflare Turnstile を設定（推奨）

[Cloudflare ダッシュボード → Turnstile → Add site] で:

- **Domain**: `<your-github-username>.github.io`
- **Widget Mode**: `Managed`（推奨）

作成すると **Site key** と **Secret key** が表示されます。

- **Secret key** → 上の `wrangler secret put TURNSTILE_SECRET_KEY` で登録。
- **Site key** → `assets/config.js` の `TURNSTILE_SITE_KEY` に貼り付け。

### 4. フロントから Worker を呼べるようにする

`assets/config.js` を編集:

```js
window.BOARD_API_URL = "https://watanabe-board.<your-cf-subdomain>.workers.dev";
window.TURNSTILE_SITE_KEY = "0x4AAA..."; // Turnstile を使う場合のみ
```

GitHub に push:

```bash
git add assets/config.js
git commit -m "Configure board API endpoint"
git push
```

数分で GitHub Pages に反映されます。

### 5. 動作確認

1. `https://<your-github-username>.github.io/.../books/ca.html` を開く
2. ハンドルネームと質問を入力して「投稿する」
3. ページ下部に投稿が表示される
4. LaTeX 表示が動くか確認: `$e^{i\pi}+1=0$` を本文に書いて投稿
5. `board/admin.html` を開いて管理者パスワードを入力 → 投稿が見えれば OK

---

## 管理者向けの操作

### 不適切な投稿を削除する

1. `https://<your-github-username>.github.io/.../board/admin.html` にアクセス
2. 管理者パスワードと対象掲示板を入力 → 「読み込み」
3. 削除したい投稿の「削除」ボタンを押す

削除はソフト削除（DB 上に履歴は残る）です。完全に消したい場合は手動で:

```bash
cd worker
npx wrangler d1 execute watanabe-board --remote --command="DELETE FROM posts WHERE id=<id>;"
```

### 全投稿をエクスポートする

```bash
npx wrangler d1 execute watanabe-board --remote --command="SELECT * FROM posts;" --json > posts.json
```

### 掲示板を増やす

`worker/src/index.js` の `VALID_BOARDS` 配列に新しい ID を追加し、
`books/<new>.html` と `board/admin.html` のセレクタにも追加してください。

---

## ローカル開発

### サイトを開く

ブラウザでローカルファイルを開けば見られます（`index.html` をダブルクリック）。
ただし掲示板の API 呼び出しはローカルでは Worker をローカル起動しないと動きません。

### Worker をローカル起動

```bash
cd worker
npm run dev
# http://localhost:8787 で起動
```

`assets/config.js` の `BOARD_API_URL` を `http://localhost:8787` に書き換えると、
ローカル DB（`.wrangler/` 以下）に投稿が保存されて動作確認できます。

---

## 無料枠について

- **GitHub Pages**: 無料・無制限（リポジトリ 1GB まで、月 100GB 帯域）
- **Cloudflare Workers**: 無料枠 10 万リクエスト/日、CPU 時間 10ms/request まで
- **Cloudflare D1**: 無料枠 5GB ストレージ・500 万行読み取り/日・10 万行書き込み/日
- **Cloudflare Turnstile**: 完全無料・無制限

教科書サポートの掲示板用途なら、**無料枠を超える可能性はほぼゼロ**です。

---

## トラブルシューティング

### 掲示板に投稿が表示されない / エラーになる

ブラウザの DevTools（`Cmd+Option+I`）の **Console** と **Network** タブを確認。
- `Failed to fetch` → `BOARD_API_URL` の設定ミスか、Worker が落ちている
- `CORS` エラー → `wrangler.toml` の `ALLOWED_ORIGINS` を GitHub Pages の URL と一致させる
- `captcha_failed` → Turnstile の Site key と Secret key が一致していない

### スパムが多い

`worker/src/index.js` の `RATE_LIMIT_MAX_POSTS` を下げるか、
`RATE_LIMIT_WINDOW_SEC` を上げてデプロイし直してください。
