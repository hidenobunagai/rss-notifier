# rss-discord-notifier

RSS/Atom フィードの更新を検出して Discord に通知する Google Apps Script (GAS) プロジェクトです。

## 機能

- 複数の RSS/Atom フィードを定期ポーリング
- 新着記事を Discord Webhook で通知
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

```javascript
// Discord Webhook URL を登録
setWebhookUrl("https://discord.com/api/webhooks/YOUR_ID/YOUR_TOKEN");

// 監視するフィード URL を登録
setFeedUrls([
  "https://example.com/feed",
  "https://blog.example.jp/rss",
]);

// 既存記事を既読としてマーク（初回通知をスキップ）
markCurrentAsRead();
```

### 3. 定期トリガーを作成

```javascript
createTimeTrigger(); // 15 分ごとに checkFeeds() を実行
```

## 定数（Code.js）

| 定数                        | デフォルト       | 説明                           |
| --------------------------- | ---------------- | ------------------------------ |
| `MAX_NOTIFICATIONS_PER_RUN` | `5`              | 1 実行あたりの最大通知件数     |
| `DISCORD_USERNAME`          | `"RSS Notifier"` | Discord に表示されるユーザー名 |

## 管理コマンド

| 関数                  | 説明                             |
| --------------------- | -------------------------------- |
| `setWebhookUrl(url)`  | Discord Webhook URL を登録       |
| `setFeedUrls(urls)`   | 監視フィード URL 一覧を設定      |
| `markCurrentAsRead()` | 現在の最新記事を既読としてマーク |
| `createTimeTrigger()` | 15 分おきのトリガーを作成        |
| `deleteTimeTrigger()` | トリガーを削除（停止）           |
| `checkFeeds()`        | 手動でフィードをチェック         |

## ファイル構成

```
.
├── Code.js           # メインスクリプト
├── appsscript.json   # GAS マニフェスト
└── .gitignore        # .clasp.json など除外
```

> **注意**: `.clasp.json`（scriptId を含む）は `.gitignore` で除外しています。
> 新しい環境で作業する場合は `clasp clone <scriptId>` で再取得してください。
