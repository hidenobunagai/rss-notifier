// RSS → Discord 通知 (GAS)
// - フィード更新を検出し、Discord Webhook に投稿します。
// - 一度に大量投稿を避けるため送信上限を設けています。
// - 既読管理は Script Properties に保存します。

// ===== 設定値 =====
// 初回セットアップ:
//   1. setWebhookUrl('<DISCORD_WEBHOOK_URL>') を実行
//   2. setFeedUrls(['https://example.com/feed', ...]) を実行
//   3. markCurrentAsRead() を実行（既存記事を通知しないようスキップ）
//   4. createTimeTrigger() を実行
const PROPERTY_WEBHOOK_URL = "discordWebhookUrl";
const PROPERTY_LAST_SEEN_PREFIX = "lastSeen:"; // lastSeen:<feedUrl> = ISO 文字列
const PROPERTY_FEED_URLS = "feedUrls"; // JSON 配列で保存
const MAX_NOTIFICATIONS_PER_RUN = 5; // 一度の実行で通知する件数上限（スパム対策）
const DISCORD_USERNAME = "RSS Notifier";

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
  // 二重作成防止（同名の既存トリガを削除）
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === "checkFeeds") {
      ScriptApp.deleteTrigger(trigger);
    }
  }
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

  for (const item of newItems) {
    try {
      notifyDiscord(item, feedUrl);
    } catch (e) {
      // 個別投稿エラーはログのみに留め、後続を続行
      Logger.log("Notify error: " + (e && e.stack ? e.stack : e));
    }
  }

  // 最後（＝最新）の日時を既読として保存
  const latest = newItems[newItems.length - 1].date;
  getScriptProperties().setProperty(PROPERTY_LAST_SEEN_PREFIX + feedUrl, latest.toISOString());
}

function fetchFeedItems(feedUrl) {
  const res = UrlFetchApp.fetch(feedUrl, {
    followRedirects: true,
    muteHttpExceptions: true,
    validateHttpsCertificates: true,
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
    return parseRss2(root);
  } else if (name === "feed") {
    return parseAtom(root);
  } else {
    // 一部 RSS 1.0 (RDF) 等の簡易対応
    const channel = root.getChild("channel") || root.getChild("channel", root.getNamespace());
    if (channel) {
      return parseRssChannel(channel);
    }
    throw new Error("Unsupported feed root: " + name);
  }
}

// RSS 2.0
function parseRss2(root) {
  const channel = root.getChild("channel");
  return parseRssChannel(channel);
}

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
function notifyDiscord(item, feedUrl) {
  const webhook = (getScriptProperties().getProperty(PROPERTY_WEBHOOK_URL) || "").trim();
  if (!webhook) {
    throw new Error(
      'Webhook URL が未設定です。setWebhookUrl("<WEBHOOK>") を先に実行してください。',
    );
  }
  const content = `新着: ${item.title}\n${item.link || ""}\n(From ${feedUrl})`;
  const payload = {
    username: DISCORD_USERNAME,
    content,
    allowed_mentions: { parse: [] },
    // embeds を使う場合は以下のように拡張可能
    // embeds: [{ title: item.title, url: item.link }]
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

// ===== ユーティリティ =====

/** Discord Webhook URL を Script Properties に登録する */
function setWebhookUrl(webhookUrl) {
  if (!webhookUrl || webhookUrl.indexOf("https://discord.com/api/webhooks/") !== 0) {
    throw new Error("不正な Webhook URL です");
  }
  getScriptProperties().setProperty(PROPERTY_WEBHOOK_URL, webhookUrl);
  Logger.log("Webhook URL を登録しました。");
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
