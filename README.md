# rss-discord-notifier

RSS/Atom フィードの更新を検出して Discord および LINE に通知する Google Apps Script (GAS) プロジェクトです。Discord / LINE はそれぞれ個別に有効化でき、両方同時にも送信可能です。

## 機能

- 複数の RSS/Atom フィードを定期ポーリング
- 新着記事を Discord Webhook および LINE Messaging API で通知
- Discord / LINE は個別に有効化可能（両方同時送信にも対応）
- 1 回の実行あたりの通知件数を制限（スパム防止）
- 既読管理を Script Properties に保存（再起動後も状態を維持）

## セットアップ

### 1. clasp でプッシュ

```bash
bun add -g @google/clasp
clasp login
clasp push
```

### 2. Script Properties を設定

GAS エディタのスクリプトエディタで以下の関数を**順に**実行します。
Discord / LINE どちらを使うかによって必要な関数が異なります（両方も可）。

```javascript
// --- Discord を使う場合 ---
// Discord Webhook URL を登録
setWebhookUrl("https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN");

// --- LINE を使う場合 ---
// LINE Messaging API のチャネルアクセストークンを登録
setLineChannelAccessToken("YOUR_LINE_CHANNEL_ACCESS_TOKEN");
// LINE の送信先 ID (ユーザー/グループ/トークルーム) を登録
setLineTargetId("YOUR_LINE_TARGET_ID");

// --- 共通 ---
// 監視するフィード URL を登録
setFeedUrls(["https://example.com/feed", "https://blog.example.jp/rss"]);

// 既存記事を既読としてマーク（初回通知をスキップ）
markCurrentAsRead();
```

> 通知先の有効条件:
>
> - Discord: `discordWebhookUrl` が設定されていれば送信
> - LINE: `lineChannelAccessToken` と `lineTargetId` が両方設定されていれば送信
> - どちらも未設定の場合はエラーで中断します。少なくとも一方は設定してください。

### 3. 定期トリガーを作成

```javascript
createTimeTrigger(); // 15 分ごとに checkFeeds() を実行
```

## 定数（Code.js）

| 定数                         | デフォルト       | 説明                                      |
| ---------------------------- | ---------------- | ----------------------------------------- |
| `MAX_NOTIFICATIONS_PER_RUN`  | `5`              | 1 実行あたりの最大通知件数                |
| `DISCORD_USERNAME`           | `"RSS Notifier"` | Discord に表示されるユーザー名            |
| `DISCORD_EMBED_COLOR`        | `3447003`        | embed の左帯の色 (#3498DB, 青)            |
| `NOTIFY_INTERVAL_MS`         | `1000`           | Discord 投稿間の待機時間 ms（レート制限） |
| `LINE_MAX_TEXT_LENGTH`       | `5000`           | LINE 1 メッセージあたりの文字数上限       |
| `LINE_MAX_MESSAGES_PER_PUSH` | `5`              | LINE 1 push あたりのメッセージ数上限      |
| `LINE_CHUNK_INTERVAL_MS`     | `1000`           | LINE push 間の待機時間 ms（レート制限）   |
| `LINE_MAX_RETRIES`           | `3`              | LINE 送信の最大リトライ回数               |

## 管理コマンド

| 関数                               | 説明                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| `setWebhookUrl(url)`               | Discord Webhook URL を登録                             |
| `setLineChannelAccessToken(token)` | LINE チャネルアクセストークンを登録                    |
| `setLineTargetId(id)`              | LINE 送信先 ID (ユーザー/グループ/トークルーム) を登録 |
| `setFeedUrls(urls)`                | 監視フィード URL 一覧を設定                            |
| `markCurrentAsRead()`              | 現在の最新記事を既読としてマーク                       |
| `createTimeTrigger()`              | 15 分おきのトリガーを作成                              |
| `deleteTimeTrigger()`              | トリガーを削除（停止）                                 |
| `checkFeeds()`                     | 手動でフィードをチェック                               |

## LINE Messaging API のセットアップ

> **注意**: 旧来の LINE Notify は 2025/3 に廃止されたため、本プロジェクトでは LINE Messaging API（公式アカウント経由の push メッセージ）を使用します。

1. [LINE Developers](https://developers.line.biz/) でプロバイダーと Messaging API チャネルを作成
2. チャネルの「Messaging API 設定」で「チャネルアクセストークン」を発行し、控える
3. 通知を受け取りたい LINE アカウント（自分自身や家族グループ）を公式アカウントと友だち追加
4. 送信先 ID を確認:
   - 個別ユーザー: 公式アカウントにメッセージを送って webhook で取得する `userId` など
   - グループ / トークルーム: 公式アカウントをグループに招待した後に同ページの「グループ / トークルーム ID」を参照
5. Apps Script で `setLineChannelAccessToken(...)` と `setLineTargetId(...)` を実行してプロパティ登録

### LINE の注意点

- 無料枠（Light Plan）では月 1,000 メッセージまで。超過分は従量課金または送信制限されるため、通知頻度に注意
- `push` API は友だち追加済みの相手にのみ届く。未追加ユーザーへの送信は失敗する
- グループ / トークルームへ送る場合は公式アカウントをその部屋に招待しておく
- アクセストークンは定期的にローテーション推奨（漏洩時は即時再発行）

## トラブルシュート

- **通知が来ない**: `discordWebhookUrl` または `lineChannelAccessToken` + `lineTargetId` が未設定ではないか確認。実行ログに `Notify error` が出ていないか確認
- **Discord 429**: サーバー側のレート制限。しばらく待つか投稿間隔を空ける
- **LINE 401 Unauthorized**: チャネルアクセストークンが不正または期限切れ。再発行して `setLineChannelAccessToken(...)` で更新
- **LINE 400 Bad Request**: `lineTargetId` が不正、または公式アカウントと友だち追加されていない。ID の種類（ユーザー / グループ / トークルーム）と友だち追加状態を確認
- **LINE で届かない（エラーなし）**: 無料枠の月 1,000 メッセージ上限に達していないか確認

## ファイル構成

```
.
├── Code.js           # メインスクリプト
├── appsscript.json   # GAS マニフェスト
└── .gitignore        # .clasp.json など除外
```

> **注意**: `.clasp.json`（scriptId を含む）は `.gitignore` で除外しています。
> 新しい環境で作業する場合は `clasp clone <scriptId>` で再取得してください。
