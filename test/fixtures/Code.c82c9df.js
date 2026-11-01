// RSS → LINE 通知 (GAS)
// - フィード更新を検出し、LINE Messaging API に投稿します。
// - 一度に大量投稿を避けるため送信上限を設けています。
// - 既読管理は Script Properties に保存します。

// ===== 設定値 =====
// 初回セットアップ:
//   1. setLineChannelAccessToken('<LINE_CHANNEL_ACCESS_TOKEN>') を実行
//   2. setLineTargetId('<LINE_TARGET_ID>') を実行
//   3. setFeedUrls(['https://example.com/feed', ...]) を実行
//   4. markCurrentAsRead() を実行（既存記事を通知しないようスキップ）
//   5. createTimeTrigger() を実行
const PROPERTY_LINE_CHANNEL_ACCESS_TOKEN = "lineChannelAccessToken";
const PROPERTY_LINE_TARGET_ID = "lineTargetId";
const PROPERTY_LAST_SEEN_PREFIX = "lastSeen:"; // lastSeen:<feedUrl> = ISO 文字列（初回移行と診断用に保持。記事選別には不使用）
const PROPERTY_SEEN_IDS_PREFIX = "seenIds:"; // seenIds:<feedUrl> = 通知済み記事 ID の JSON 配列
const MAX_SEEN_IDS = 50; // seenIds に残す件数上限
// Script Properties は 1 値あたり 9KB まで。長い URL のフィードでも保存が失敗しないよう
// 件数だけでなく JSON 文字列の長さでも切る（保存に失敗すると毎回同じ記事を再通知し続ける）
const MAX_SEEN_IDS_JSON_LENGTH = 6000;
const PROPERTY_FEED_URLS = "feedUrls"; // JSON 配列で保存
const MAX_NOTIFICATIONS_PER_RUN = 5; // 一度の実行で通知する件数上限（スパム対策）
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
  const props = getScriptProperties();
  for (const url of feedUrls) {
    try {
      const items = fetchFeedItems(url);
      if (!items || !items.length) continue;
      items.sort((a, b) => a.date - b.date);
      const ids = mergeSeenIds(
        [],
        items.map((it) => it.id),
      );
      if (ids.length > 0) {
        props.setProperty(PROPERTY_SEEN_IDS_PREFIX + url, JSON.stringify(ids));
      }
      const latest = items[items.length - 1].date;
      if (latest && latest.getTime && !isNaN(latest.getTime())) {
        props.setProperty(PROPERTY_LAST_SEEN_PREFIX + url, latest.toISOString());
      }
    } catch (e) {
      Logger.log("markCurrentAsRead error: " + (e && e.stack ? e.stack : e));
    }
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
 * 既読 ID に含まれない新着記事のみを抽出する
 * @param {Array<{id: string, [key: string]: any}>} items
 * @param {string[]} seenIds
 * @returns {Array<{id: string, [key: string]: any}>}
 */
function selectNewItems(items, seenIds) {
  return items.filter((it) => !seenIds.includes(it.id));
}

/**
 * 既読 ID に今回通知した ID をマージし、保存上限まで切り詰める（新しい方を残す）
 * @param {string[]} seenIds
 * @param {string[]} notifiedIds
 * @returns {string[]}
 */
function mergeSeenIds(seenIds, notifiedIds) {
  // 通知済み ID どうしの重複を先に畳む（フィード側に同じ id の記事が複数あると
  // notifiedIds に重複が入り、MAX_SEEN_IDS / JSON 長の上限を余計に食う）
  const unique = Array.from(new Set(notifiedIds));
  const filtered = seenIds.filter((id) => !unique.includes(id));
  const merged = filtered.concat(unique).slice(-MAX_SEEN_IDS);
  while (merged.length > 1 && JSON.stringify(merged).length > MAX_SEEN_IDS_JSON_LENGTH) {
    merged.shift(); // 長い ID のフィードでは古い方から落とす
  }
  return merged;
}

/**
 * 過去の日時ウォーターマーク (lastSeen) から既読 ID 配列へ移行する。
 * 移行元の記事が保存上限より多い場合、あふれた古い記事は次回以降に未読として
 * 扱われる（1 回だけの再通知。フィードの保持件数は通常これを下回る）
 * @param {Array<{id: string, date: Date, [key: string]: any}>} items
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

  // 過去の日時ウォーターマークからの初回移行
  const lastSeenIso = props.getProperty(PROPERTY_LAST_SEEN_PREFIX + feedUrl) || "";
  const lastSeenDate = lastSeenIso ? new Date(lastSeenIso) : null;
  const migrated = migrateSeenIds(items, lastSeenDate);
  if (migrated.length > 0) {
    props.setProperty(PROPERTY_SEEN_IDS_PREFIX + feedUrl, JSON.stringify(migrated));
  }
  return migrated;
}

// ===== 実装本体 =====
function processFeed(feedUrl) {
  let items = fetchFeedItems(feedUrl);
  if (!items || !items.length) {
    return;
  }

  // 古い→新しい順に並べ替え
  items.sort((a, b) => a.date - b.date);

  const props = getScriptProperties();
  const seenIds = loadSeenIds(props, feedUrl, items);
  let newItems = selectNewItems(items, seenIds);
  if (!newItems.length) {
    return; // 更新なし
  }

  // スパム防止のため一度に送る最大件数を制限（古い方から順に送り、残りは次回の実行に回す）
  if (newItems.length > MAX_NOTIFICATIONS_PER_RUN) {
    newItems = newItems.slice(0, MAX_NOTIFICATIONS_PER_RUN);
  }

  const lineToken = (props.getProperty(PROPERTY_LINE_CHANNEL_ACCESS_TOKEN) || "").trim();
  const lineTargetId = (props.getProperty(PROPERTY_LINE_TARGET_ID) || "").trim();
  const hasLine = !!lineToken && !!lineTargetId;

  if (!hasLine) {
    throw new Error(
      "通知先が未設定です。setLineChannelAccessToken(...) + setLineTargetId(...) を先に実行してください。",
    );
  }

  // ----- LINE 送信 (プレーンテキストをチャンク分割で一括送信) -----
  let lastSuccessDate = null;
  const notifiedIds = [];
  // push が成功した記事 index。途中で失敗しても、ここまで届いた記事だけは既読にする
  const sentIndexes = [];
  try {
    const messages = newItems.map((item) => buildItemMessage(item, feedUrl));
    postToLineInChunks(lineToken, lineTargetId, messages, sentIndexes);
    // LINE 成功をもって既読基準にする
    lastSuccessDate = newItems[newItems.length - 1].date;
  } catch (e) {
    Logger.log("Notify error (LINE): " + (e && e.stack ? e.stack : e));
  }
  for (const indexes of sentIndexes) {
    for (const index of indexes) {
      notifiedIds.push(newItems[index].id);
    }
  }

  // 送信成功した記事 ID を既読として保存（未送信分は次回リトライ対象に残す）
  const mergedSeenIds = mergeSeenIds(seenIds, notifiedIds);
  if (mergedSeenIds.length > 0) {
    props.setProperty(PROPERTY_SEEN_IDS_PREFIX + feedUrl, JSON.stringify(mergedSeenIds));
  }
  if (lastSuccessDate) {
    props.setProperty(
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
    return parseRssChannel(root.getChild("channel"), feedUrl);
  } else if (name === "feed") {
    return parseAtom(root, feedUrl);
  } else {
    throw new Error("Unsupported feed root: " + name);
  }
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
  const items = channel.getChildren("item");
  const out = [];
  for (const it of items) {
    const title = getChildText(it, "title");
    const link = resolveLink(getChildText(it, "link"), feedUrl);
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

  // 既読状態
  const hasSeenState = feedUrls.some(
    (url) =>
      !!getScriptProperties().getProperty(PROPERTY_SEEN_IDS_PREFIX + url) ||
      !!getScriptProperties().getProperty(PROPERTY_LAST_SEEN_PREFIX + url),
  );
  config.hasReadState = hasSeenState;
  if (feedUrls.length > 0 && !hasSeenState) {
    warnings.push("既読状態がありません。markCurrentAsRead() を実行すると、既存記事の通知をスキップできます。");
  }

  return {
    ready: warnings.length === 0,
    warnings: warnings,
    config: config,
  };
}
