// Code.js（GAS）をテストから読み込むための最小ハーネス。
// Code.js のトップレベルは定数と関数宣言だけで GAS API を呼ばないので、
// new Function に GAS グローバルのスタブを渡して評価できる。
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../Code.js", import.meta.url), "utf8");

// テストから呼ぶ関数だけを返す（足すときはここに 1 行足す）
const EXPORTS = [
  "processFeed",
  "fetchFeedItems",
  "safeParseDate",
  "normalizeLineMessage",
  "buildDiscordPayload",
  "postToLineInChunks",
  "parseSeenIds",
  "selectNewItems",
  "mergeSeenIds",
];

/**
 * GAS のグローバルを素のオブジェクトで差し替えて Code.js を読み込む。
 * `root` に関数を渡すと、fetch のたびにその戻り値を XML ツリーとして使う
 * （テスト中でフィードに記事を足すため）。
 */
export function loadGas({ properties = {}, fetch, root, log } = {}) {
  const store = new Map(Object.entries(properties));
  const noFetch = () => {
    throw new Error("UrlFetchApp.fetch がスタブされていません");
  };
  const gas = {
    Logger: { log: log || (() => {}) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (store.has(key) ? store.get(key) : null),
        setProperty: (key, value) => void store.set(key, String(value)),
        deleteProperty: (key) => void store.delete(key),
      }),
    },
    UrlFetchApp: { fetch: fetch || noFetch },
    Utilities: { sleep: () => {}, formatDate: (date, tz, fmt) => date.toISOString() },
    Session: { getScriptTimeZone: () => "Asia/Tokyo" },
    XmlService: {
      // 実際の XML 解析はせず、テストが組み立てた要素ツリーをそのまま返す
      parse: () => ({ getRootElement: () => (typeof root === "function" ? root() : root) }),
      getNamespace: (uri) => ({ uri }),
    },
  };
  const names = Object.keys(gas);
  const api = new Function(...names, `${SOURCE}\nreturn { ${EXPORTS.join(", ")} };`)(
    ...names.map((name) => gas[name]),
  );
  return { api, get: (key) => store.get(key) };
}

/** GAS XmlService の要素を模した最小オブジェクト */
export function el(name, text = "", children = [], attrs = {}) {
  return {
    getName: () => name,
    getText: () => text,
    getChildren: (childName) => children.filter((c) => !childName || c.getName() === childName),
    getChild: (childName) => children.find((c) => c.getName() === childName) || null,
    getNamespace: () => ({ uri: "" }),
    getAttribute: (attr) => (attr in attrs ? { getValue: () => attrs[attr] } : null),
  };
}

/** RSS 2.0 の <rss><channel><item>… を組み立てる（undefined の要素は入れない） */
export function rss(items) {
  const itemNodes = items.map((it) =>
    el(
      "item",
      "",
      [
        it.title !== undefined ? el("title", it.title) : null,
        it.link !== undefined ? el("link", it.link) : null,
        it.guid !== undefined ? el("guid", it.guid) : null,
        it.pubDate !== undefined ? el("pubDate", it.pubDate) : null,
      ].filter(Boolean),
    ),
  );
  return el("rss", "", [el("channel", "", itemNodes)]);
}

/** 常に 200 を返す UrlFetchApp.fetch スタブ（送信内容を captured に記録） */
export function okFetch(captured = []) {
  return (url, params) => {
    captured.push({ url, params });
    return { getResponseCode: () => 200, getContentText: () => "", getHeaders: () => ({}) };
  };
}
