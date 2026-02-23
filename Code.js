// RSS → Discord 通知 (GAS)
// - フィード更新を検出し、Discord Webhook に投稿します。
// - 一度に大量投稿を避けるため送信上限を設けています。
// - 既読管理は Script Properties に保存します。

// ===== 設定値 =====
// 初回は `setWebhookUrl('<YOUR_WEBHOOK_URL>')` を実行して登録してください。
var PROPERTY_WEBHOOK_URL = "discordWebhookUrl";
var PROPERTY_LAST_SEEN_PREFIX = "lastSeen:"; // lastSeen:<feedUrl> = ISO 文字列
var MAX_NOTIFICATIONS_PER_RUN = 5; // 一度の実行で通知する件数上限（多すぎるスパム対策）
var DISCORD_USERNAME = "RSS Notifier";
var FEED_URLS = [
  "https://misato-gurashi.com/feed",
  "http://www.misatopi.com/feed/",
];

// ===== エントリポイント =====
function checkFeeds() {
  var errors = [];
  for (var i = 0; i < FEED_URLS.length; i++) {
    var url = FEED_URLS[i];
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
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkFeeds") {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger("checkFeeds").timeBased().everyMinutes(15).create();
}

// 作成済みの時間主導トリガ（checkFeeds）を停止（削除）
function deleteTimeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === "checkFeeds") {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  Logger.log("Removed triggers: " + removed);
}

// 初回導入時に現在の最新記事を既読として記録（通知を発生させない）
function markCurrentAsRead() {
  for (var i = 0; i < FEED_URLS.length; i++) {
    var url = FEED_URLS[i];
    try {
      var items = fetchFeedItems(url);
      if (!items || !items.length) continue;
      items.sort(function (a, b) {
        return a.date - b.date;
      });
      var latest = items[items.length - 1].date;
      if (latest && latest.getTime && !isNaN(latest.getTime())) {
        getScriptProperties().setProperty(
          PROPERTY_LAST_SEEN_PREFIX + url,
          latest.toISOString()
        );
      }
    } catch (e) {
      Logger.log("markCurrentAsRead error: " + (e && e.stack ? e.stack : e));
    }
  }
}

// ===== 実装本体 =====
function processFeed(feedUrl) {
  var items = fetchFeedItems(feedUrl);
  if (!items || !items.length) {
    return;
  }

  // 古い→新しい順に並べ替え
  items.sort(function (a, b) {
    return a.date - b.date;
  });

  var lastSeenIso =
    getScriptProperties().getProperty(PROPERTY_LAST_SEEN_PREFIX + feedUrl) ||
    "";
  var lastSeenDate = lastSeenIso ? new Date(lastSeenIso) : null;

  var newItems = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (!lastSeenDate || it.date > lastSeenDate) {
      newItems.push(it);
    }
  }
  if (!newItems.length) {
    return; // 更新なし
  }

  // スパム防止のため一度に送る最大件数を制限（最後の N 件＝最新から順に）
  if (newItems.length > MAX_NOTIFICATIONS_PER_RUN) {
    newItems = newItems.slice(newItems.length - MAX_NOTIFICATIONS_PER_RUN);
  }

  for (var j = 0; j < newItems.length; j++) {
    try {
      notifyDiscord(newItems[j], feedUrl);
    } catch (e) {
      // 個別投稿エラーはログのみに留め、後続を続行
      Logger.log("Notify error: " + (e && e.stack ? e.stack : e));
    }
  }

  // 最後（＝最新）の日時を既読として保存
  var latest = newItems[newItems.length - 1].date;
  getScriptProperties().setProperty(
    PROPERTY_LAST_SEEN_PREFIX + feedUrl,
    latest.toISOString()
  );
}

function fetchFeedItems(feedUrl) {
  var res = UrlFetchApp.fetch(feedUrl, {
    followRedirects: true,
    muteHttpExceptions: true,
    validateHttpsCertificates: true,
  });
  var code = res.getResponseCode();
  if (code >= 400) {
    throw new Error("Fetch failed " + code + " for " + feedUrl);
  }
  var xmlText = res.getContentText();
  var doc = XmlService.parse(xmlText);
  var root = doc.getRootElement();
  var name = root.getName().toLowerCase();

  if (name === "rss") {
    return parseRss2(root);
  } else if (name === "feed") {
    return parseAtom(root);
  } else {
    // 一部 RSS 1.0 (RDF) 等の簡易対応
    var channel =
      root.getChild("channel") || root.getChild("channel", root.getNamespace());
    if (channel) {
      return parseRssChannel(channel);
    }
    throw new Error("Unsupported feed root: " + name);
  }
}

// RSS 2.0
function parseRss2(root) {
  var channel = root.getChild("channel");
  return parseRssChannel(channel);
}

function parseRssChannel(channel) {
  var items = channel.getChildren("item");
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var title = getChildText(it, "title");
    var link = getChildText(it, "link");
    var guid = getChildText(it, "guid");
    var pubDate =
      getChildText(it, "pubDate") ||
      getChildTextNS(it, "date", "http://purl.org/dc/elements/1.1/");
    var date = safeParseDate(pubDate);
    var id = guid || link || title + "|" + (pubDate || "");
    out.push({ id: id, title: title, link: link, date: date });
  }
  return out;
}

// Atom 1.0
function parseAtom(root) {
  var ns = root.getNamespace();
  var entries = root.getChildren("entry", ns);
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var titleEl = e.getChild("title", ns);
    var title = titleEl ? titleEl.getText() : "";

    // link 要素（rel="alternate" を優先、無ければ最初の href）
    var link = "";
    var links = e.getChildren("link", ns);
    for (var j = 0; j < links.length; j++) {
      var relAttr = links[j].getAttribute("rel");
      var rel = relAttr ? relAttr.getValue() : "";
      var hrefAttr = links[j].getAttribute("href");
      var href = hrefAttr ? hrefAttr.getValue() : "";
      if (!href) continue;
      if (rel === "alternate") {
        link = href;
        break;
      }
      if (!link) {
        link = href;
      }
    }

    var idEl = e.getChild("id", ns);
    var id = idEl ? idEl.getText() : link || title;
    var updatedEl = e.getChild("updated", ns) || e.getChild("published", ns);
    var date = safeParseDate(updatedEl ? updatedEl.getText() : "");
    out.push({ id: id, title: title, link: link, date: date });
  }
  return out;
}

// ===== Discord 通知 =====
function notifyDiscord(item, feedUrl) {
  var webhook = (
    getScriptProperties().getProperty(PROPERTY_WEBHOOK_URL) || ""
  ).trim();
  if (!webhook) {
    throw new Error(
      'Webhook URL が未設定です。setWebhookUrl("<WEBHOOK>") を先に実行してください。'
    );
  }
  var content =
    "新着: " +
    item.title +
    "\n" +
    (item.link || "") +
    "\n" +
    "(From " +
    feedUrl +
    ")";
  var payload = {
    username: DISCORD_USERNAME,
    content: content,
    allowed_mentions: { parse: [] },
    // embeds を使う場合は以下のように拡張可能
    // embeds: [{ title: item.title, url: item.link }]
  };
  var res = UrlFetchApp.fetch(webhook, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code >= 400) {
    throw new Error(
      "Discord post failed " + code + ": " + res.getContentText()
    );
  }
}

// ===== ユーティリティ =====
function setWebhookUrl(webhookUrl) {
  if (
    !webhookUrl ||
    webhookUrl.indexOf("https://discord.com/api/webhooks/") !== 0
  ) {
    throw new Error("不正な Webhook URL です");
  }
  getScriptProperties().setProperty(PROPERTY_WEBHOOK_URL, webhookUrl);
}

function getScriptProperties() {
  return PropertiesService.getScriptProperties();
}

function getChildText(el, name) {
  var children = el.getChildren();
  name = (name || "").toLowerCase();
  for (var i = 0; i < children.length; i++) {
    if (children[i].getName().toLowerCase() === name) {
      return children[i].getText();
    }
  }
  return "";
}

function getChildTextNS(el, name, nsUri) {
  var ns = XmlService.getNamespace(nsUri);
  var child = el.getChild(name, ns);
  return child ? child.getText() : "";
}

function safeParseDate(s) {
  if (!s) return new Date(0);
  var d = new Date(s);
  if (isNaN(d.getTime())) return new Date(0);
  return d;
}
