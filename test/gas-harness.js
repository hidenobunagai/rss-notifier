// Minimal harness that loads Code.js (Apps Script) into tests.
// Code.js's top level only declares constants and functions and never calls a
// GAS API, so it can be evaluated with new Function and stubbed GAS globals.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../Code.js", import.meta.url), "utf8");

// Functions exposed to the tests (add a line here to expose another)
const EXPORTS = [
  "checkFeeds",
  "processFeed",
  "fetchFeedItems",
  "safeParseDate",
  "normalizeLineMessage",
  "postToLineInChunks",
  "parseSeenIds",
  "selectNewItems",
  "mergeSeenIds",
  "seenKey",
  "validateSetup",
  "resolveLink",
];

/**
 * Loads Code.js with plain-object stand-ins for the GAS globals.
 * If `root` is a function, its return value is used as the XML tree on every
 * fetch (so a test can add articles to the feed between runs).
 * `source` evaluates that string instead of `../Code.js` (used to change
 * constants, e.g. to make processFeed need several pushes).
 * `lockBusy` makes the script lock unavailable; `triggers` lists the handler
 * names of the project's triggers.
 */
export function loadGas({ properties = {}, fetch, root, log, source = SOURCE, lockBusy = false, triggers = [] } = {}) {
  const store = new Map(Object.entries(properties));
  const sleeps = [];
  let uuid = 0;
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
    ScriptApp: {
      getProjectTriggers: () => triggers.map((handler) => ({ getHandlerFunction: () => handler })),
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => !lockBusy, releaseLock: () => {} }),
    },
    Utilities: {
      sleep: (ms) => void sleeps.push(ms),
      getUuid: () => `uuid-${++uuid}`,
      formatDate: (date, tz, fmt) => date.toISOString(),
      DigestAlgorithm: { MD5: "md5" },
      Charset: { UTF_8: "utf8" },
      // GAS returns Java bytes, i.e. signed numbers in -128..127
      computeDigest: (algorithm, value, charset) =>
        Array.from(createHash(algorithm).update(value, charset).digest(), (b) => (b > 127 ? b - 256 : b)),
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 255)).toString("base64url").padEnd(24, "="),
    },
    Session: { getScriptTimeZone: () => "Asia/Tokyo" },
    XmlService: {
      // No real XML parsing: returns the element tree the test built
      parse: () => ({ getRootElement: () => (typeof root === "function" ? root() : root) }),
      getNamespace: (uri) => ({ uri }),
    },
  };
  const names = Object.keys(gas);
  // Functions missing from `source` (e.g. an older Code.js) are exported as undefined
  const exportList = EXPORTS.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`);
  const api = new Function(...names, `${source}\nreturn { ${exportList.join(", ")} };`)(
    ...names.map((name) => gas[name]),
  );
  return { api, get: (key) => store.get(key), sleeps };
}

/** Minimal stand-in for a GAS XmlService element */
export function el(name, text = "", children = [], attrs = {}, nsUri = "") {
  return {
    getName: () => name,
    getText: () => text,
    getChildren: (childName) => children.filter((c) => !childName || c.getName() === childName),
    getChild: (childName) => children.find((c) => c.getName() === childName) || null,
    getNamespace: () => ({ uri: nsUri, getURI: () => nsUri }),
    getAttribute: (attr) => (attr in attrs ? { getValue: () => attrs[attr] } : null),
  };
}

/** Builds <rss><channel><item>... for RSS 2.0 (undefined fields are left out) */
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

/** UrlFetchApp.fetch stub that always answers 200 and records each call in `captured` */
export function okFetch(captured = []) {
  return (url, params) => {
    captured.push({ url, params });
    return { getResponseCode: () => 200, getContentText: () => "", getHeaders: () => ({}) };
  };
}
