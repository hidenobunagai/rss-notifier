// RSS → Discord / LINE 通知 (GAS)
// - フィード更新を検出し、Discord Webhook および LINE Messaging API に投稿します。
// - 一度に大量投稿を避けるため送信上限を設けています。
// - 既読管理は Script Properties に保存します。
// - Discord / LINE はそれぞれ個別に有効化でき、両方同時にも送信可能です。

// ===== 設定値 =====
// 初回セットアップ:
//   1. setWebhookUrl('<DISCORD_WEBHOOK_URL>') を実行（Discord を使う場合）
//   2. setLineChannelAccessToken('<LINE_CHANNEL_ACCESS_TOKEN>') を実行（LINE を使う場合）
//   3. setLineTargetId('<LINE_TARGET_ID>') を実行（LINE を使う場合）
//   4. setFeedUrls(['https://example.com/feed', ...]) を実行
//   5. markCurrentAsRead() を実行（既存記事を通知しないようスキップ）
//   6. createTimeTrigger() を実行
const PROPERTY_WEBHOOK_URL = "discordWebhookUrl";
const PROPERTY_LINE_CHANNEL_ACCESS_TOKEN = "lineChannelAccessToken";
const PROPERTY_LINE_TARGET_ID = "lineTargetId";
const PROPERTY_LAST_SEEN_PREFIX = "lastSeen:"; // lastSeen:<feedUrl> = ISO 文字列
const PROPERTY_FEED_URLS = "feedUrls"; // JSON 配列で保存
const MAX_NOTIFICATIONS_PER_RUN = 5; // 一度の実行で通知する件数上限（スパム対策）
const DISCORD_USERNAME = "RSS Notifier";
const DISCORD_EMBED_COLOR = 3447003; // #3498DB (青)
const NOTIFY_INTERVAL_MS = 1000; // Discord レート制限対策: 投稿間隔 (ms)
// LINE Messaging API 関連 (LINE Notify は 2025/3 廃止のため非採用)
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000; // 1メッセージあたりの文字数上限
const LINE_MAX_MESSAGES_PER_PUSH = 5; // 1 push あたりのメッセージ数上限
const LINE_CHUNK_INTERVAL_MS = 1000; // レート制限対策: push 間待機 (ms)

// ===== エントリポイント =====
function checkFeeds() {
  const feedUrls = getFeedUrls();
  if (!feedUrls.length) {
    Logger.log("feedUrls が未設定です。setFeedUrls([...]) を先に実行してください。");
    return;
  }
  const errors = [];
  for (const url of feedUrls) {
    try {
      processFeed(url);
    } catch (e) {
      errors.push(url + " -> " + (e && e.stack ? e.stack : e));
    }
  }
  if (errors.length) {
    Logger.log("Errors: \n" + errors.join("\n"));
  }
}

// 時間主導トリガを作成（例: 15分毎）
function createTimeTrigger() {
  deleteTimeTrigger(); // 二重作成防止（同名の既存トリガを削除）
  ScriptApp.newTrigger("checkFeeds").timeBased().everyMinutes(15).create();
}

// 作成済みの時間主導トリガ（checkFeeds）を停止（削除）
function deleteTimeTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === "checkFeeds") {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  }
  Logger.log("Removed triggers: " + removed);
}

// 初回導入時に現在の最新記事を既読として記録（通知を発生させない）
function markCurrentAsRead() {
  const feedUrls = getFeedUrls();
  if (!feedUrls.length) {
    Logger.log("feedUrls が未設定です。setFeedUrls([...]) を先に実行してください。");
    return;
  }
  for (const url of feedUrls) {
    try {
      const items = fetchFeedItems(url);
      if (!items || !items.length) continue;
      items.sort((a, b) => a.date - b.date);
      const latest = items[items.length - 1].date;
      if (latest && latest.getTime && !isNaN(latest.getTime())) {
        getScriptProperties().setProperty(PROPERTY_LAST_SEEN_PREFIX + url, latest.toISOString());
      }
    } catch (e) {
      Logger.log("markCurrentAsRead error: " + (e && e.stack ? e.stack : e));
    }
  }
}

// ===== 実装本体 =====
function processFeed(feedUrl) {
  let items = fetchFeedItems(feedUrl);
  if (!items || !items.length) {
    return;
  }

  // 古い→新しい順に並べ替え
  items.sort((a, b) => a.date - b.date);

  const lastSeenIso = getScriptProperties().getProperty(PROPERTY_LAST_SEEN_PREFIX + feedUrl) || "";
  const lastSeenDate = lastSeenIso ? new Date(lastSeenIso) : null;

  let newItems = items.filter((it) => !lastSeenDate || it.date > lastSeenDate);
  if (!newItems.length) {
    return; // 更新なし
  }

  // スパム防止のため一度に送る最大件数を制限（最後の N 件＝最新から順に）
  if (newItems.length > MAX_NOTIFICATIONS_PER_RUN) {
    newItems = newItems.slice(newItems.length - MAX_NOTIFICATIONS_PER_RUN);
  }

  const webhook = (getScriptProperties().getProperty(PROPERTY_WEBHOOK_URL) || "").trim();
  const lineToken = (
    getScriptProperties().getProperty(PROPERTY_LINE_CHANNEL_ACCESS_TOKEN) || ""
  ).trim();
  const lineTargetId = (getScriptProperties().getProperty(PROPERTY_LINE_TARGET_ID) || "").trim();
  const hasDiscord = !!webhook;
  const hasLine = !!lineToken && !!lineTargetId;

  if (!hasDiscord && !hasLine) {
    throw new Error(
      "通知先が未設定です。setWebhookUrl(...) または setLineChannelAccessToken(...) + setLineTargetId(...) を先に実行してください。",
    );
  }

  // ----- Discord 送信 (embed 形式で 1 記事ずつ投稿) -----
  let lastSuccessDate = null;
  if (hasDiscord) {
    for (let i = 0; i < newItems.length; i++) {
      if (i > 0) Utilities.sleep(NOTIFY_INTERVAL_MS);
      const item = newItems[i];
      try {
        notifyDiscord(item, feedUrl, webhook);
        lastSuccessDate = item.date;
      } catch (e) {
        // 個別投稿エラーはログのみに留め、後続を続行
        Logger.log("Notify error (Discord): " + (e && e.stack ? e.stack : e));
      }
    }
  }

  // ----- LINE 送信 (プレーンテキストをチャンク分割で一括送信) -----
  if (hasLine) {
    try {
      const messages = newItems.map((item) => buildItemMessage(item, feedUrl));
      postToLineInChunks(lineToken, lineTargetId, messages);
      // Discord 未使用時は LINE 成功をもって既読基準にする
      if (!hasDiscord) {
        lastSuccessDate = newItems[newItems.length - 1].date;
      }
    } catch (e) {
      Logger.log("Notify error (LINE): " + (e && e.stack ? e.stack : e));
    }
  }

  // 送信成功した最新記事の日時のみを既読として保存（失敗分は次回リトライ対象に残す）
  if (lastSuccessDate) {
    getScriptProperties().setProperty(
      PROPERTY_LAST_SEEN_PREFIX + feedUrl,
      lastSuccessDate.toISOString(),
    );
  }
}

function fetchFeedItems(feedUrl) {
  const res = UrlFetchApp.fetch(feedUrl, {
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 400) {
    throw new Error("Fetch failed " + code + " for " + feedUrl);
  }
  const xmlText = res.getContentText();
  const doc = XmlService.parse(xmlText);
  const root = doc.getRootElement();
  const name = root.getName().toLowerCase();

  if (name === "rss") {
    return parseRssChannel(root.getChild("channel"));
  } else if (name === "feed") {
    return parseAtom(root);
  } else {
    throw new Error("Unsupported feed root: " + name);
  }
}

// RSS 2.0
function parseRssChannel(channel) {
  const items = channel.getChildren("item");
  const out = [];
  for (const it of items) {
    const title = getChildText(it, "title");
    const link = getChildText(it, "link");
    const guid = getChildText(it, "guid");
    const pubDate =
      getChildText(it, "pubDate") || getChildTextNS(it, "date", "http://purl.org/dc/elements/1.1/");
    const date = safeParseDate(pubDate);
    const id = guid || link || title + "|" + (pubDate || "");
    out.push({ id, title, link, date });
  }
  return out;
}

// Atom 1.0
function parseAtom(root) {
  const ns = root.getNamespace();
  const entries = root.getChildren("entry", ns);
  const out = [];
  for (const e of entries) {
    const titleEl = e.getChild("title", ns);
    const title = titleEl ? titleEl.getText() : "";

    // link 要素（rel="alternate" を優先、無ければ最初の href）
    let link = "";
    const links = e.getChildren("link", ns);
    for (const linkEl of links) {
      const relAttr = linkEl.getAttribute("rel");
      const rel = relAttr ? relAttr.getValue() : "";
      const hrefAttr = linkEl.getAttribute("href");
      const href = hrefAttr ? hrefAttr.getValue() : "";
      if (!href) continue;
      if (rel === "alternate") {
        link = href;
        break;
      }
      if (!link) {
        link = href;
      }
    }

    const idEl = e.getChild("id", ns);
    const id = idEl ? idEl.getText() : link || title;
    const updatedEl = e.getChild("updated", ns) || e.getChild("published", ns);
    const date = safeParseDate(updatedEl ? updatedEl.getText() : "");
    out.push({ id, title, link, date });
  }
  return out;
}

// ===== Discord 通知 =====
function notifyDiscord(item, feedUrl, webhook) {
  const hasTimestamp = item.date && item.date.getTime() !== 0;
  const payload = {
    username: DISCORD_USERNAME,
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: item.title || "(タイトルなし)",
        ...(item.link ? { url: item.link } : {}),
        color: DISCORD_EMBED_COLOR,
        footer: { text: feedUrl },
        ...(hasTimestamp ? { timestamp: item.date.toISOString() } : {}),
      },
    ],
  };
  const res = UrlFetchApp.fetch(webhook, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code >= 400) {
    throw new Error("Discord post failed " + code + ": " + res.getContentText());
  }
}

// ===== LINE 通知 =====

/**
 * 通知メッセージを構築 (Discord / LINE 共通のプレーンテキスト)
 * Markdown 非依存のため LINE でもそのまま表示可能。
 */
function buildItemMessage(item, feedUrl) {
  const title = item.title || "(タイトルなし)";
  const lines = ["【RSS 更新】", `- タイトル: ${title}`];
  if (item.link) lines.push(`- リンク: ${item.link}`);
  if (item.date && item.date.getTime() !== 0) {
    const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
    lines.push(`- 公開日時: ${Utilities.formatDate(item.date, tz, "yyyy/MM/dd(EEE) HH:mm")}`);
  }
  lines.push(`- フィード: ${feedUrl}`);
  return lines.join("\n");
}

/**
 * LINE Messaging API へのメッセージ送信 (push) をチャンク分割で実行
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 各記事の通知メッセージ配列
 */
function postToLineInChunks(channelAccessToken, targetId, messages) {
  const sep = "\n\n";
  const chunks = [];
  let buffer = "";
  for (const rawMsg of messages) {
    const msg = normalizeLineMessage(rawMsg, LINE_MAX_TEXT_LENGTH);
    if (!msg) continue;

    const joined = buffer ? buffer + sep + msg : msg;
    // LINE_MAX_TEXT_LENGTH を超える場合は新しいチャンクへ
    if (joined.length > LINE_MAX_TEXT_LENGTH) {
      if (buffer) chunks.push(buffer);
      buffer = msg;
    } else {
      buffer = joined;
    }
  }
  if (buffer) chunks.push(buffer);

  // LINE_MAX_MESSAGES_PER_PUSH 件ずつ 1 push にまとめて送信
  for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    if (i > 0) Utilities.sleep(LINE_CHUNK_INTERVAL_MS);
    const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
    postToLine(channelAccessToken, targetId, batch);
  }
}

/**
 * LINE メッセージを LINE_MAX_TEXT_LENGTH に収まるよう丸める
 */
function normalizeLineMessage(message, maxLen) {
  if (!message) return "";
  if (message.length <= maxLen) return message;
  const ellipsis = "…";
  const limit = Math.max(maxLen - ellipsis.length, 0);
  return `${message.slice(0, limit)}${ellipsis}`;
}

/**
 * LINE Messaging API の push エンドポイントへ送信（429 時は Retry-After に従いリトライ）
 * @param {string} channelAccessToken
 * @param {string} targetId
 * @param {string[]} messageTexts 1 push に含めるテキストメッセージ配列 (最大 LINE_MAX_MESSAGES_PER_PUSH)
 */
function postToLine(channelAccessToken, targetId, messageTexts) {
  const payload = {
    to: targetId,
    messages: messageTexts.map((text) => ({ type: "text", text })),
  };
  const params = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= LINE_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(LINE_PUSH_URL, params);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    // 401 (認証エラー) / 400 (リクエスト不正) はリトライせず即時例外
    if (code === 401 || code === 400) {
      const body = res.getContentText();
      throw new Error(
        `LINE 認証/リクエストエラー (${code}): ${body} - アクセストークン/ターゲットIDを確認してください`,
      );
    }

    if (code === 429 && attempt < LINE_MAX_RETRIES) {
      let waitMs = LINE_CHUNK_INTERVAL_MS * attempt;
      const retryAfter = res.getHeaders()["Retry-After"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) waitMs = parsed * 1000;
      }
      Logger.log(
        `LINE レート制限 (429)。${waitMs}ms 後にリトライ (${attempt}/${LINE_MAX_RETRIES})`,
      );
      Utilities.sleep(waitMs);
      continue;
    }

    const body = res.getContentText();
    throw new Error(`LINE 送信エラー (${code}): ${body}`);
  }
}

// ===== ユーティリティ =====

/** Discord Webhook URL を Script Properties に登録する */
function setWebhookUrl(webhookUrl) {
  const validHost =
    /^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//;
  if (!webhookUrl || !validHost.test(webhookUrl)) {
    throw new Error("不正な Webhook URL です");
  }
  getScriptProperties().setProperty(PROPERTY_WEBHOOK_URL, webhookUrl);
  Logger.log("Webhook URL を登録しました。");
}

/** LINE Messaging API のチャネルアクセストークンを Script Properties に登録する */
function setLineChannelAccessToken(token) {
  if (!token || typeof token !== "string") {
    throw new Error("チャネルアクセストークンが空、または文字列ではありません");
  }
  getScriptProperties().setProperty(PROPERTY_LINE_CHANNEL_ACCESS_TOKEN, token.trim());
  Logger.log("LINE Channel Access Token を登録しました。");
}

/** LINE の送信先 ID (ユーザー/グループ/トークルーム) を Script Properties に登録する */
function setLineTargetId(targetId) {
  if (!targetId || typeof targetId !== "string") {
    throw new Error("送信先 ID が空、または文字列ではありません");
  }
  getScriptProperties().setProperty(PROPERTY_LINE_TARGET_ID, targetId.trim());
  Logger.log("LINE Target ID を登録しました。");
}

/**
 * 監視する RSS/Atom フィードの URL 一覧を Script Properties に登録する
 * @param {string[]} urls - フィード URL の配列
 * @example setFeedUrls(['https://example.com/feed', 'https://blog.example.jp/rss'])
 */
function setFeedUrls(urls) {
  if (!Array.isArray(urls) || !urls.length) {
    throw new Error("urls は空でない配列で指定してください");
  }
  getScriptProperties().setProperty(PROPERTY_FEED_URLS, JSON.stringify(urls));
  Logger.log("feedUrls を登録しました: " + urls.join(", "));
}

/** Script Properties からフィード URL 配列を取得する */
function getFeedUrls() {
  const raw = getScriptProperties().getProperty(PROPERTY_FEED_URLS) || "[]";
  try {
    const urls = JSON.parse(raw);
    return Array.isArray(urls) ? urls : [];
  } catch (e) {
    Logger.log("feedUrls の解析に失敗しました: " + e);
    return [];
  }
}

function getScriptProperties() {
  return PropertiesService.getScriptProperties();
}

function getChildText(el, name) {
  const children = el.getChildren();
  const nameLower = (name || "").toLowerCase();
  for (const child of children) {
    if (child.getName().toLowerCase() === nameLower) {
      return child.getText();
    }
  }
  return "";
}

function getChildTextNS(el, name, nsUri) {
  const ns = XmlService.getNamespace(nsUri);
  const child = el.getChild(name, ns);
  return child ? child.getText() : "";
}

function safeParseDate(s) {
  if (!s) return new Date(0);
  const d = new Date(s);
  if (isNaN(d.getTime())) return new Date(0);
  return d;
}
