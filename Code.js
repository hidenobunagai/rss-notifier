// RSS → LINE 通知 (GAS)
// - フィード更新を検出し、LINE Messaging API に投稿します。
// - 一度に大量投稿を避けるため送信上限を設けています。
// - 既読管理は Script Properties に保存します。

// ===== 設定値 =====
// 初回セットアップ:
//   1. setLineChannelAccessToken('<LINE_CHANNEL_ACCESS_TOKEN>') を実行
//   2. setLineTargetId('<LINE_TARGET_ID>') を実行
//   3. setFeedUrls(['https://example.com/feed', ...]) を実行
//   4. createTimeTrigger() を実行
// A newly added feed's existing articles are marked read on its first check,
// so only later articles are notified. markCurrentAsRead() resets every feed
// to "all current articles read" (it also drops articles still waiting to be sent).
const PROPERTY_LINE_CHANNEL_ACCESS_TOKEN = "lineChannelAccessToken";
const PROPERTY_LINE_TARGET_ID = "lineTargetId";
const PROPERTY_LAST_SEEN_PREFIX = "lastSeen:"; // lastSeen:<feedUrl> = ISO 文字列（初回移行と診断用に保持。記事選別には不使用）
const PROPERTY_SEEN_IDS_PREFIX = "seenIds:"; // seenIds:<feedUrl> = 通知済み記事 ID の JSON 配列
// Only the newest MAX_SEEN_IDS items of a feed are tracked; older items are ignored.
// IDs are stored as short hashes (seenKey) so 200 keys always fit the JSON budget below.
const MAX_SEEN_IDS = 200;
// Script Properties allow 9KB per value. 200 hashed keys take about 5.4KB.
const MAX_SEEN_IDS_JSON_LENGTH = 6000;
const SEEN_KEY_PREFIX = "h:"; // marks a hashed key; entries without it are legacy raw IDs
const PROPERTY_FEED_URLS = "feedUrls"; // JSON 配列で保存
const MAX_NOTIFICATIONS_PER_RUN = 5; // max articles per feed per run (anti-spam); the rest waits for the next run
// LINE Messaging API 関連 (LINE Notify は 2025/3 廃止のため非採用)
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000; // 1メッセージあたりの文字数上限
const LINE_MAX_MESSAGES_PER_PUSH = 5; // 1 push あたりのメッセージ数上限
const LINE_CHUNK_INTERVAL_MS = 1000; // レート制限対策: push 間待機 (ms)
const LOCK_WAIT_MS = 30 * 1000; // how long a run waits for an overlapping run to finish

// ===== エントリポイント =====
function checkFeeds() {
  const feedUrls = getFeedUrls();
  if (!feedUrls.length) {
    Logger.log("feedUrls が未設定です。setFeedUrls([...]) を先に実行してください。");
    return;
  }
  notifyFeeds(feedUrls);
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
  withScriptLock("markCurrentAsRead", () => markFeedsAsRead(feedUrls));
}

function markFeedsAsRead(feedUrls) {
  const props = getScriptProperties();
  const errors = [];
  for (const url of feedUrls) {
    try {
      const items = fetchFeedItems(url);
      if (!items || !items.length) continue;
      items.sort((a, b) => a.date - b.date);
      const tracked = trackedItems(items);
      const trackedIds = tracked.map((it) => it.id);
      const ids = mergeSeenIds([], trackedIds, trackedIds);
      if (ids.length > 0) {
        props.setProperty(PROPERTY_SEEN_IDS_PREFIX + url, JSON.stringify(ids));
      }
      const latest = items[items.length - 1].date;
      if (latest && latest.getTime && !isNaN(latest.getTime())) {
        props.setProperty(PROPERTY_LAST_SEEN_PREFIX + url, latest.toISOString());
      }
    } catch (e) {
      errors.push(url + " -> " + (e && e.stack ? e.stack : e));
    }
  }
  if (errors.length) {
    throw new Error("markCurrentAsRead failed for " + errors.length + " feed(s):\n" + errors.join("\n"));
  }
}

// ===== 既読管理 (ID ベース) =====

/**
 * 保存された既読 ID の JSON 文字列を解析し、文字列の配列のみを返す
 * @param {string|null} raw
 * @returns {string[]}
 */
function parseSeenIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      Logger.log("seenIds の値が配列ではありません: " + raw);
      return [];
    }
    return parsed.filter((id) => typeof id === "string");
  } catch (e) {
    Logger.log("seenIds の解析に失敗しました: " + e);
    return [];
  }
}

/**
 * Hashes an item ID into the compact key stored in seenIds.
 * @param {string} id
 * @returns {string}
 */
function seenKey(id) {
  const digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    String(id),
    Utilities.Charset.UTF_8,
  );
  return SEEN_KEY_PREFIX + Utilities.base64EncodeWebSafe(digest).replace(/=+$/, "");
}

/**
 * Normalizes a stored seenIds entry to a hashed key (legacy entries hold raw IDs).
 * @param {string} entry
 * @returns {string}
 */
function toSeenKey(entry) {
  return entry.startsWith(SEEN_KEY_PREFIX) ? entry : seenKey(entry);
}

/**
 * Keeps only the newest MAX_SEEN_IDS items (items must be sorted oldest first).
 * Every tracked item's key then fits in seenIds, so a long feed cannot cycle
 * items out of the read state and re-notify them.
 * @param {Array<{id: string, [key: string]: any}>} items
 * @returns {Array<{id: string, [key: string]: any}>}
 */
function trackedItems(items) {
  return items.slice(-MAX_SEEN_IDS);
}

/**
 * Filters items whose ID is not in seenIds, collapsing repeated IDs within the run.
 * @param {Array<{id: string, [key: string]: any}>} items
 * @param {string[]} seenIds stored entries (hashed keys or legacy raw IDs)
 * @returns {Array<{id: string, [key: string]: any}>}
 */
function selectNewItems(items, seenIds) {
  const seenSet = new Set(seenIds.map(toSeenKey));
  const pickedKeys = new Set();
  return items.filter((it) => {
    const key = seenKey(it.id);
    if (seenSet.has(key) || pickedKeys.has(key)) {
      return false;
    }
    pickedKeys.add(key);
    return true;
  });
}

/**
 * Builds the seenIds to store after a run.
 * Keys of items still in the feed are always kept. Keys of items that left the
 * feed are kept as history (oldest dropped first) while they fit, so an item that
 * briefly drops out and comes back is not notified again.
 * @param {string[]} seenIds stored entries (hashed keys or legacy raw IDs)
 * @param {string[]} notifiedIds raw IDs notified in this run
 * @param {string[]} [feedIds] raw IDs of the tracked items currently in the feed
 * @returns {string[]} hashed keys
 */
function mergeSeenIds(seenIds, notifiedIds, feedIds = []) {
  const storedKeys = seenIds.map(toSeenKey);
  const notifiedKeys = notifiedIds.map(seenKey);
  const known = new Set(storedKeys.concat(notifiedKeys));
  const inFeed = Array.from(new Set(feedIds.map(seenKey))).filter((key) => known.has(key));
  const inFeedSet = new Set(inFeed);
  const history = Array.from(new Set(storedKeys.concat(notifiedKeys))).filter(
    (key) => !inFeedSet.has(key),
  );
  const merged = history.concat(inFeed);
  let drop = Math.min(Math.max(0, merged.length - MAX_SEEN_IDS), history.length);
  while (
    drop < history.length &&
    JSON.stringify(merged.slice(drop)).length > MAX_SEEN_IDS_JSON_LENGTH
  ) {
    drop++;
  }
  return merged.slice(drop);
}

/**
 * Migrates the old date watermark (lastSeen) to seenIds: items dated at or
 * before the watermark count as read.
 * @param {Array<{id: string, date: Date, [key: string]: any}>} items tracked items
 * @param {Date|null} lastSeenDate
 * @returns {string[]}
 */
function migrateSeenIds(items, lastSeenDate) {
  if (!lastSeenDate || isNaN(lastSeenDate.getTime())) {
    return [];
  }
  return mergeSeenIds(
    [],
    items.filter((it) => it.date <= lastSeenDate).map((it) => it.id),
    items.map((it) => it.id),
  );
}

/**
 * 既読 ID 一覧を取得する（未設定時は lastSeen からの初回移行を行う）
 * @param {GoogleAppsScript.Properties.Properties} props
 * @param {string} feedUrl
 * @param {Array<{id: string, date: Date, [key: string]: any}>} items
 * @returns {string[]}
 */
function loadSeenIds(props, feedUrl, items) {
  const stored = props.getProperty(PROPERTY_SEEN_IDS_PREFIX + feedUrl);
  if (stored !== null) {
    return parseSeenIds(stored);
  }

  const lastSeenIso = props.getProperty(PROPERTY_LAST_SEEN_PREFIX + feedUrl) || "";
  if (!lastSeenIso) {
    // A feed with no read state (newly added): treat everything currently in it
    // as read instead of sending its backlog. Only later articles are notified.
    const ids = items.map((it) => it.id);
    const baseline = mergeSeenIds([], ids, ids);
    props.setProperty(PROPERTY_SEEN_IDS_PREFIX + feedUrl, JSON.stringify(baseline));
    Logger.log("New feed, marked " + baseline.length + " current item(s) as read: " + feedUrl);
    return baseline;
  }

  // One-time migration from the old date watermark
  const migrated = migrateSeenIds(items, new Date(lastSeenIso));
  if (migrated.length > 0) {
    props.setProperty(PROPERTY_SEEN_IDS_PREFIX + feedUrl, JSON.stringify(migrated));
  }
  return migrated;
}

// ===== 実装本体 =====

/** Checks a single feed (manual runs and tests); see notifyFeeds. */
function processFeed(feedUrl) {
  notifyFeeds([feedUrl]);
}

/**
 * Collects new items from every feed and delivers them together, so one run
 * costs one LINE push (up to LINE_MAX_MESSAGES_PER_PUSH text bubbles) instead
 * of one push per feed. Errors are collected and thrown at the end so the
 * trigger run is marked failed and Apps Script emails the owner.
 * @param {string[]} feedUrls
 */
function notifyFeeds(feedUrls) {
  withScriptLock("notifyFeeds", () => notifyFeedsLocked(feedUrls));
}

/**
 * Runs fn while holding the script lock. A manual run that overlaps the
 * trigger would otherwise read the same read state and send items twice.
 * If the lock stays busy, the run is skipped (the next run picks things up).
 */
function withScriptLock(label, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) {
    Logger.log(label + ": another run is in progress, skipped.");
    return;
  }
  try {
    fn();
  } finally {
    lock.releaseLock();
  }
}

function notifyFeedsLocked(feedUrls) {
  const props = getScriptProperties();
  const errors = [];
  const pending = [];
  for (const url of feedUrls) {
    try {
      const entry = collectNewItems(props, url);
      if (entry) pending.push(entry);
    } catch (e) {
      errors.push(url + " -> " + (e && e.stack ? e.stack : e));
    }
  }

  if (pending.length) {
    try {
      deliverItems(props, pending);
    } catch (e) {
      errors.push("LINE -> " + (e && e.stack ? e.stack : e));
    }
  }

  if (errors.length) {
    // Without this throw an expired token or a dead feed fails silently forever.
    throw new Error("Feed check failed (" + errors.length + " error(s)):\n" + errors.join("\n"));
  }
}

/**
 * Fetches a feed and returns its tracked items, read state and new items,
 * or null when there is nothing to send.
 * @returns {{url: string, items: Array<object>, seenIds: string[], newItems: Array<object>}|null}
 */
function collectNewItems(props, feedUrl) {
  let items = fetchFeedItems(feedUrl);
  if (!items || !items.length) {
    return null;
  }

  // Oldest first, then keep only the newest MAX_SEEN_IDS items
  items.sort((a, b) => a.date - b.date);
  items = trackedItems(items);

  const seenIds = loadSeenIds(props, feedUrl, items);
  // Oldest first, capped per feed; the rest is picked up by the next run
  const newItems = selectNewItems(items, seenIds).slice(0, MAX_NOTIFICATIONS_PER_RUN);
  if (!newItems.length) {
    return null;
  }
  return { url: feedUrl, items, seenIds, newItems };
}

/**
 * Sends the new items of all feeds in as few pushes as possible and stores,
 * per feed, the items that were actually delivered (a failed push leaves its
 * items unread for the next run). Rethrows the send error after saving.
 */
function deliverItems(props, pending) {
  const lineToken = (props.getProperty(PROPERTY_LINE_CHANNEL_ACCESS_TOKEN) || "").trim();
  const lineTargetId = (props.getProperty(PROPERTY_LINE_TARGET_ID) || "").trim();
  if (!lineToken || !lineTargetId) {
    throw new Error(
      "通知先が未設定です。setLineChannelAccessToken(...) + setLineTargetId(...) を先に実行してください。",
    );
  }

  const messages = [];
  const owners = []; // owners[i] = { entry, item } for messages[i]
  for (const entry of pending) {
    entry.notifiedIds = [];
    for (const item of entry.newItems) {
      messages.push(buildItemMessage(item, entry.url));
      owners.push({ entry, item });
    }
  }

  let sendError = null;
  const sentIndexes = [];
  try {
    postToLineInChunks(lineToken, lineTargetId, messages, sentIndexes);
  } catch (e) {
    sendError = e; // rethrown after the delivered part is saved as read
  }
  for (const indexes of sentIndexes) {
    for (const index of indexes) {
      owners[index].entry.notifiedIds.push(owners[index].item.id);
    }
  }

  for (const entry of pending) {
    const merged = mergeSeenIds(
      entry.seenIds,
      entry.notifiedIds,
      entry.items.map((it) => it.id),
    );
    if (merged.length > 0) {
      props.setProperty(PROPERTY_SEEN_IDS_PREFIX + entry.url, JSON.stringify(merged));
    }
    if (!sendError) {
      props.setProperty(
        PROPERTY_LAST_SEEN_PREFIX + entry.url,
        entry.newItems[entry.newItems.length - 1].date.toISOString(),
      );
    }
  }
  if (sendError) {
    throw sendError;
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
  const xmlText = decodeFeedText(res);
  const doc = XmlService.parse(xmlText);
  const root = doc.getRootElement();
  const name = root.getName().toLowerCase();

  if (name === "rss") {
    return parseRssChannel(root.getChild("channel"), feedUrl);
  } else if (name === "rdf") {
    return parseRdf(root, feedUrl);
  } else if (name === "feed") {
    return parseAtom(root, feedUrl);
  } else {
    throw new Error("Unsupported feed root: " + name);
  }
}

/**
 * Decodes a feed response. A charset in Content-Type wins; without one, the
 * XML declaration's encoding (e.g. Shift_JIS, EUC-JP) is used instead of
 * silently decoding as UTF-8. Unknown charsets fall back to the default.
 * @param {GoogleAppsScript.URL_Fetch.HTTPResponse} res
 * @returns {string}
 */
function decodeFeedText(res) {
  const contentType = getHeaderValue(res.getHeaders(), "Content-Type");
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType);
  let charset = fromHeader ? fromHeader[1] : "";
  if (!charset) {
    // ISO-8859-1 maps every byte, so the ASCII declaration reads correctly
    const head = res.getContentText("ISO-8859-1").slice(0, 300);
    const declared = /^(?:\u00EF\u00BB\u00BF)?\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
    charset = declared ? declared[1] : "UTF-8";
  }
  try {
    return res.getContentText(charset);
  } catch (e) {
    Logger.log("Unknown charset " + charset + ", decoding with the default: " + e);
    return res.getContentText();
  }
}

/**
 * Looks up an HTTP response header case-insensitively (HTTP/2 sends lower case).
 * @param {Object<string, string>} headers
 * @param {string} name
 * @returns {string}
 */
function getHeaderValue(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === lower) return String(headers[key]);
  }
  return "";
}

/**
 * 記事リンクを絶対 URL へ解決する（RSS の <link>・Atom の href が相対の場合の仕様）
 * GAS の V8 には URL クラスが無いので、正規表現 + パス連結で自前実装する
 * （開発者ガイドの「Unavailable APIs」で URL は利用不可と明記されている）。
 * xml:base は見ない。解決できない場合は元の値をそのまま返す。
 * ponytail: WHATWG URL と完全一致はしない（パス内の空セグメントの圧縮・パーセント
 * デコード・ホストの小文字化・空リンクの扱い）。フィードの link は実用上これで足りる。
 * 完全一致が必要になったら whatwg-url 系のポリフィルを入れる。
 * @param {string} link
 * @param {string} feedUrl
 * @returns {string}
 */
function resolveLink(link, feedUrl) {
  if (!link) return "";
  const text = String(link).trim();
  if (!text) return ""; // <link> が空・空白のみなら「リンク無し」扱い
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text)) return text; // 既に絶対 URL
  // origin = http(s)://host、dir = feedUrl のディレクトリ（末尾スラッシュ込み）
  const base = /^(https?):\/\/([^\/?#]*)([^?#]*)/i.exec(String(feedUrl || "").trim());
  if (!base) return text; // feedUrl が http(s) でなければ解決しない
  const scheme = (base[1] || "").toLowerCase();
  const host = base[2] || "";
  if (!scheme || !host) return text;
  const basePath = base[3] || "/";
  if (text.startsWith("//")) return scheme + ":" + text; // スキーマ相対
  const query = text.indexOf("?");
  const hash = text.indexOf("#");
  const cut = query < 0 ? hash : hash < 0 ? query : Math.min(query, hash);
  const path = cut < 0 ? text : text.slice(0, cut);
  const tail = cut < 0 ? "" : text.slice(cut);
  const dir = path.startsWith("/")
    ? "/"
    : basePath.slice(0, basePath.lastIndexOf("/") + 1);
  const origin = scheme + "://" + host;
  const segments = (dir + path).split("/");
  const out = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  const prefix = out.length ? origin + "/" + out.join("/") : origin;
  return path.endsWith("/") ? prefix + "/" : prefix + tail;
}

// RSS 2.0
function parseRssChannel(channel, feedUrl) {
  return channel.getChildren("item").map((it) => parseRssItem(it, feedUrl, getChildText(it, "guid")));
}

// RSS 1.0 (RDF): <item> elements are children of <rdf:RDF>, identified by rdf:about
const RDF_NS_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
function parseRdf(root, feedUrl) {
  const rdfNs = XmlService.getNamespace(RDF_NS_URI);
  return root
    .getChildren()
    .filter((child) => child.getName().toLowerCase() === "item")
    .map((it) => {
      const about = it.getAttribute("about", rdfNs);
      return parseRssItem(it, feedUrl, about ? about.getValue() : "");
    });
}

/**
 * Reads one RSS 1.0 / 2.0 item. The ID falls back from primaryId to the link,
 * then to title + date.
 */
function parseRssItem(it, feedUrl, primaryId) {
  const title = getChildText(it, "title");
  const link = resolveLink(getChildText(it, "link"), feedUrl);
  const pubDate =
    getChildText(it, "pubDate") || getChildTextNS(it, "date", "http://purl.org/dc/elements/1.1/");
  const date = safeParseDate(pubDate);
  const id = primaryId || link || title + "|" + (pubDate || "");
  return { id, title, link, date };
}

// Atom 1.0
function parseAtom(root, feedUrl) {
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
    const idText = idEl ? idEl.getText() : "";
    const id = idText || link || title;
    const updatedEl = e.getChild("updated", ns) || e.getChild("published", ns);
    const date = safeParseDate(updatedEl ? updatedEl.getText() : "");
    out.push({ id, title, link: resolveLink(link, feedUrl), date });
  }
  return out;
}

// ===== LINE 通知 =====

/**
 * 通知メッセージを構築 (LINE 送信用のプレーンテキスト)
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
 * 途中で push が失敗した場合に「どの記事まで届いたか」を判定できるよう、
 * push が成功するたびに、その push へ含めた記事 index（messages の添字）を
 * 呼び出し側の `sentIndexes` に積む（例外が出ても積み上がった分は残る）。
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 各記事の通知メッセージ配列
 * @param {number[][]} sentIndexes 成功した push ごとに記事 index を積む配列（呼び出し側が用意）
 */
function postToLineInChunks(channelAccessToken, targetId, messages, sentIndexes) {
  const sep = "\n\n";
  const chunks = [];
  const chunkIndexes = []; // chunks と対応。chunks[n] に入る記事の index
  let buffer = "";
  let bufferIndexes = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = normalizeLineMessage(messages[index], LINE_MAX_TEXT_LENGTH);
    if (!msg) continue;

    const joined = buffer ? buffer + sep + msg : msg;
    // LINE_MAX_TEXT_LENGTH を超える場合は新しいチャンクへ
    if (joined.length > LINE_MAX_TEXT_LENGTH) {
      if (buffer) {
        chunks.push(buffer);
        chunkIndexes.push(bufferIndexes);
      }
      buffer = msg;
      bufferIndexes = [index];
    } else {
      buffer = joined;
      bufferIndexes.push(index);
    }
  }
  if (buffer) {
    chunks.push(buffer);
    chunkIndexes.push(bufferIndexes);
  }

  // LINE_MAX_MESSAGES_PER_PUSH 件ずつ 1 push にまとめて送信
  for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    if (i > 0) Utilities.sleep(LINE_CHUNK_INTERVAL_MS);
    const batchIndexes = [];
    for (let j = i; j < Math.min(i + LINE_MAX_MESSAGES_PER_PUSH, chunks.length); j++) {
      batchIndexes.push.apply(batchIndexes, chunkIndexes[j]);
    }
    postToLine(channelAccessToken, targetId, chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH));
    sentIndexes.push(batchIndexes); // 送れたぶんだけ積む（途中で失敗しても残す）
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
 * Sends one push to the LINE Messaging API.
 * 5xx, 429 and network errors are retried with exponential backoff (or the
 * Retry-After header). Every attempt carries the same X-Line-Retry-Key, so a
 * retry of a push LINE already accepted is answered with 409 instead of being
 * delivered twice; 409 on a retry therefore counts as delivered.
 * @param {string} channelAccessToken
 * @param {string} targetId
 * @param {string[]} messageTexts texts for one push (at most LINE_MAX_MESSAGES_PER_PUSH)
 */
function postToLine(channelAccessToken, targetId, messageTexts) {
  const payload = {
    to: targetId,
    messages: messageTexts.map((text) => ({ type: "text", text })),
  };
  const params = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${channelAccessToken}`,
      "X-Line-Retry-Key": Utilities.getUuid(),
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= LINE_MAX_RETRIES; attempt++) {
    const backoffMs = LINE_CHUNK_INTERVAL_MS * Math.pow(2, attempt - 1);
    let res;
    try {
      res = UrlFetchApp.fetch(LINE_PUSH_URL, params);
    } catch (e) {
      // Network error or timeout: the push may or may not have been accepted
      if (attempt < LINE_MAX_RETRIES) {
        Logger.log(`LINE 通信エラー。${backoffMs}ms 後にリトライ (${attempt}/${LINE_MAX_RETRIES}): ${e}`);
        Utilities.sleep(backoffMs);
        continue;
      }
      throw e;
    }
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;
    if (code === 409 && attempt > 1) return; // an earlier attempt was already accepted

    // 400 / 401 / 403 will not succeed on retry
    if (code === 400 || code === 401 || code === 403) {
      throw new Error(
        `LINE 認証/リクエストエラー (${code}): ${res.getContentText()} - アクセストークン/ターゲットIDを確認してください`,
      );
    }

    if ((code === 429 || code >= 500) && attempt < LINE_MAX_RETRIES) {
      let waitMs = backoffMs;
      const parsed = parseInt(getHeaderValue(res.getHeaders(), "Retry-After"), 10);
      if (!Number.isNaN(parsed)) waitMs = parsed * 1000;
      Logger.log(`LINE 一時エラー (${code})。${waitMs}ms 後にリトライ (${attempt}/${LINE_MAX_RETRIES})`);
      Utilities.sleep(waitMs);
      continue;
    }

    throw new Error(`LINE 送信エラー (${code}): ${res.getContentText()}`);
  }
}

// ===== ユーティリティ =====

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

// ===== 設定検証ユーティリティ =====
/**
 * 現在のセットアップ状態を検証し、結果を返します。
 * 家族が「なぜ通知が届かないのか」を診断するのに便利です。
 *
 * @returns {{ready: boolean, warnings: string[], config: object}}
 */
function validateSetup() {
  const warnings = [];
  const config = {};

  // フィードURL
  const feedUrls = getFeedUrls();
  config.feedUrls = feedUrls;
  if (!feedUrls.length) {
    warnings.push("フィードURLが未設定です。setFeedUrls([...]) を実行してください。");
  }

  const lineToken = getScriptProperties().getProperty(PROPERTY_LINE_CHANNEL_ACCESS_TOKEN);
  const lineTarget = getScriptProperties().getProperty(PROPERTY_LINE_TARGET_ID);
  config.lineConfigured = !!(lineToken && lineTarget);

  if (!config.lineConfigured) {
    warnings.push("通知先が未設定です。LINE の設定を行ってください。");
  }

  return {
    ready: warnings.length === 0,
    warnings: warnings,
    config: config,
  };
}
