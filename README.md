# DearthSocial

DearthSocialのアカウント登録・ログイン・ログアウト・パスワード変更・アカウント削除、投稿・返信機能を提供します。Netlify FunctionsとPostgreSQLで動作します。

## 必要環境

- Node.js 20以上
- PostgreSQLデータベース

## ローカル起動

```bash
npm install
DATABASE_URL='postgresql://ユーザー:パスワード@ホスト/データベース?sslmode=require' \
SESSION_SECRET='十分に長いランダムな秘密文字列' \
npm start
```

ブラウザで <http://localhost:3000> を開いてください。ローカルPostgreSQLがTLSを使わない場合は `PGSSL=false` を設定します。

## Netlifyデプロイ

1. NetlifyでこのGitHubリポジトリをインポートします。
2. Build commandは `npm install`、Publish directoryは `public` にします（`netlify.toml`にも設定済み）。
3. Netlifyのサイト設定で環境変数を設定します。
   - `DATABASE_URL`: PostgreSQLプロバイダーの接続URL
   - `SESSION_SECRET`: 十分に長いランダム文字列
4. デプロイします。`netlify/functions/api.js` がAPIリクエストをExpressへ渡し、`/api/*` のURLを維持します。

接続URLと秘密鍵はソースコードやチャットへ貼らず、Netlifyの環境変数へ登録してください。PostgreSQLプロバイダーの接続数上限に応じて、接続プールサイズを調整してください。

## 機能

- アカウントIDは英数字と`_`のみ、2～30文字。大文字は小文字へ変換し、ハイフン不可
- パスワードは2～72文字
- 投稿（全角2・半角1文字換算で256文字まで）と返信（同64文字まで）
- 新着順で投稿50件、投稿ごとに返信最大100件を表示
- PostgreSQLにアカウント、投稿、返信、ログインセッションを保存
- アカウント削除時に該当アカウントの投稿・返信も削除

## データ移行について

この変更は新しいPostgreSQLデータベースに空のテーブルを作成します。既存のSQLiteアカウント・投稿は自動コピーされません。既存データが必要な場合は、旧環境のSQLiteファイルを取得して別途移行してください。SQLiteファイルを取得できない場合、旧データの復元はできません。
