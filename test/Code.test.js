// Code.js（GAS）の純関数と選別ロジックのテスト。
// GAS API はガスハーネスが差し替えるので、bun test からそのまま呼べる。
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { el, loadGas, okFetch, rss } from "./gas-harness.js";

const FEED = "https://example.com/feed";
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_SETUP = {
  lineChannelAccessToken: "token",
  lineTargetId: "U1234567890",
  feedUrls: JSON.stringify([FEED]),
};

// LINE 送信（push エンドポイント宛）を拾い、記事タイトルの配列を返す
function sentTitles(captured) {
  return captured
    .filter((c) => c.url === LINE_PUSH_URL)
    .flatMap((c) => JSON.parse(c.params.payload).messages.map((m) => m.text))
    .flatMap((text) => [...text.matchAll(/- タイトル: (.+)$/gm)].map((m) => m[1]));
}

describe("parseRssChannel / fetchFeedItems", () => {
  test("RSS の item から id（guid → link → title|pubDate）と日時を取り出す", () => {
    const root = rss([
      { title: "guid あり", link: "https://example.com/1", guid: "g1", pubDate: "Tue, 15 Sep 2026 09:00:00 GMT" },
      { title: "link のみ", link: "https://example.com/2" },
      { title: "どちらも無し", pubDate: "Tue, 15 Sep 2026 10:00:00 GMT" },
    ]);
    const { api } = loadGas({ root, fetch: okFetch() });
    expect(api.fetchFeedItems(FEED)).toEqual([
      { id: "g1", title: "guid あり", link: "https://example.com/1", date: new Date("2026-09-15T09:00:00Z") },
      { id: "https://example.com/2", title: "link のみ", link: "https://example.com/2", date: new Date(0) },
      { id: "どちらも無し|Tue, 15 Sep 2026 10:00:00 GMT", title: "どちらも無し", link: "", date: new Date("2026-09-15T10:00:00Z") },
    ]);
  });

  test("取得が 4xx / 5xx なら例外にする", () => {
    const root = rss([]);
    const { api } = loadGas({
      root,
      fetch: () => ({ getResponseCode: () => 500, getContentText: () => "", getHeaders: () => ({}) }),
    });
    expect(() => api.fetchFeedItems(FEED)).toThrow("Fetch failed 500");
  });
});

describe("safeParseDate", () => {
  test("未指定・空文字・解析不能は 1970-01-01 (Date(0))", () => {
    const { api } = loadGas();
    expect(api.safeParseDate("").getTime()).toBe(0);
    expect(api.safeParseDate(undefined).getTime()).toBe(0);
    expect(api.safeParseDate("not a date").getTime()).toBe(0);
  });

  test("ISO 8601 と RFC 822 を解析できる", () => {
    const { api } = loadGas();
    expect(api.safeParseDate("2026-09-15T00:00:00Z").toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(api.safeParseDate("Tue, 15 Sep 2026 09:00:00 GMT").toISOString()).toBe("2026-09-15T09:00:00.000Z");
  });
});

describe("normalizeLineMessage", () => {
  test("上限以内はそのまま", () => {
    const { api } = loadGas();
    expect(api.normalizeLineMessage("hello", 5000)).toBe("hello");
  });

  test("上限超過は maxLen 文字に丸めて末尾を … にする", () => {
    const { api } = loadGas();
    const out = api.normalizeLineMessage("a".repeat(20), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  test("空文字は空文字", () => {
    const { api } = loadGas();
    expect(api.normalizeLineMessage("", 10)).toBe("");
  });
});

describe("postToLineInChunks", () => {
  test("5000 字を超えるメッセージはチャンク分割され、各 push は 5 件以内", () => {
    const captured = [];
    const { api } = loadGas({ fetch: okFetch(captured) });
    const messages = ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000)];
    api.postToLineInChunks("token", "target", messages, []);

    expect(captured.length).toBeGreaterThan(0);
    const texts = captured.flatMap((c) => JSON.parse(c.params.payload).messages.map((m) => m.text));
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(5000);
    for (const c of captured) {
      expect(JSON.parse(c.params.payload).messages.length).toBeLessThanOrEqual(5);
      expect(c.params.headers.Authorization).toBe("Bearer token");
    }
  });

  test("push が成功するたびに、含めた記事 index が呼び出し側の配列に積まれる", () => {
    const { api } = loadGas({ fetch: okFetch() });
    const messages = ["a".repeat(4000), "b".repeat(4000), "c".repeat(4000), "d".repeat(4000)];
    // 1 メッセージ = 1 チャンク。5 チャンク 1 push なので push は 1 回 = 全 index
    const sentIndexes = [];
    api.postToLineInChunks("token", "target", messages, sentIndexes);
    expect(sentIndexes).toEqual([[0, 1, 2, 3]]);

    // 同じチャンクに畳まれた場合も元の index に戻る
    const merged = [];
    api.postToLineInChunks("token", "target", ["a", "b", "c".repeat(4000)], merged);
    expect(merged).toEqual([[0, 1, 2]]);
  });

  test("途中で push が失敗しても、成功した push 分の index は残る", () => {
    const { api } = loadGas({
      fetch: () => ({ getResponseCode: () => 500, getContentText: () => "", getHeaders: () => ({}) }),
    });
    const sentIndexes = [];
    expect(() =>
      api.postToLineInChunks("token", "target", Array.from({ length: 6 }, () => "a".repeat(4000)), sentIndexes),
    ).toThrow("LINE 送信エラー (500)");
    expect(sentIndexes).toEqual([]); // 1 push 目も失敗したので何も積まれない
  });
});

// 2026-09-16 に実測した取りこぼし 3 経路（日時ウォーターマークが原因）を、
// ID ベースの既読に直した後の期待挙動として固定する。
describe("processFeed: ID ベースの既読", () => {
  const rawItems = (n) =>
    Array.from({ length: n }, (_, i) => ({
      title: `A${i + 1}`,
      link: `${FEED}/${i + 1}`,
      guid: `a${i + 1}`,
      pubDate: `Tue, ${String(i + 1).padStart(2, "0")} Sep 2026 00:00:00 GMT`,
    }));

  test("① 上限 5 件を超える新着は、古い方から 5 件ずつ次回以降に通知される（取りこぼし無し）", () => {
    const captured = [];
    const root = rss(rawItems(10));
    const { api, get } = loadGas({ properties: LINE_SETUP, fetch: okFetch(captured), root });

    api.processFeed(FEED);
    const first = sentTitles(captured);
    expect(first).toEqual(["A1", "A2", "A3", "A4", "A5"]); // 古い方から 5 件

    captured.length = 0;
    api.processFeed(FEED);
    const second = sentTitles(captured);
    expect(second).toEqual(["A6", "A7", "A8", "A9", "A10"]); // 残りは次の 15 分で拾われる

    // 10 件すべてが 1 回ずつ、古い→新しい順に通知される
    expect([...first, ...second]).toEqual(rawItems(10).map((it) => it.title));

    // 既読 ID も 10 件分が保存される
    expect(JSON.parse(get("seenIds:" + FEED)).sort()).toEqual(rawItems(10).map((it) => it.guid).sort());
  });

  test("② pubDate が無いフィードでも、新しい記事が届けば通知される", () => {
    const captured = [];
    const items = [
      { title: "B1", link: `${FEED}/b1` },
      { title: "B2", link: `${FEED}/b2` },
      { title: "B3", link: `${FEED}/b3` },
    ];
    const { api } = loadGas({
      properties: LINE_SETUP,
      fetch: okFetch(captured),
      root: () => rss(items),
    });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["B1", "B2", "B3"]);

    items.push({ title: "B4", link: `${FEED}/b4` });
    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["B4"]); // 日時が 1970 でも ID なら新着と判定できる
  });

  test("③ LINE 送信が失敗したら既読にせず、次回の実行で全件再送される", () => {
    const captured = [];
    let lineCode = 500;
    const root = rss(rawItems(3));
    const fetch = (url, params) => {
      const code = url === LINE_PUSH_URL ? lineCode : 200;
      if (code < 400) captured.push({ url, params }); // 成功した送信だけを記録する
      return { getResponseCode: () => code, getContentText: () => "", getHeaders: () => ({}) };
    };
    const { api } = loadGas({ properties: LINE_SETUP, fetch, root });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]); // 送信失敗なので既読も進まない

    lineCode = 200;
    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A1", "A2", "A3"]); // 全件が 1 度ずつ送られる
  });

  test("同じ記事は 2 度通知されない（通常経路）", () => {
    const captured = [];
    const root = rss(rawItems(3));
    const { api, get } = loadGas({ properties: LINE_SETUP, fetch: okFetch(captured), root });
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A1", "A2", "A3"]);
    expect(JSON.parse(get("seenIds:" + FEED))).toEqual(["a1", "a2", "a3"]);

    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]);
  });

  // チャンク分割送信の途中で push が失敗すると、既に届いた分の記事まで
  // 既読にならず次回に再送されてしまう（重複通知）。
  test("④ 2 チャンク目だけ 500 → 1 チャンク目の記事は再送されず、2 チャンク目は再送される", () => {
    const captured = [];
    let pushCount = 0;
    let failOnce = true;
    const fetch = (url, params) => {
      if (url !== LINE_PUSH_URL) {
        return { getResponseCode: () => 200, getContentText: () => "", getHeaders: () => ({}) };
      }
      pushCount++;
      const code = pushCount === 2 && failOnce ? 500 : 200; // 2 番目の push だけ 1 回だけ失敗
      if (code < 400) captured.push({ url, params });
      return { getResponseCode: () => code, getContentText: () => "", getHeaders: () => ({}) };
    };

    // 1 push = 5 チャンク。2 チャンク目の push まで作るため上限を持ち上げる
    // （processFeed は 5 件しか送らないので、現物の設定では 1 push で終わる）
    const source = readFileSync(new URL("../Code.js", import.meta.url), "utf8").replace(
      "const MAX_NOTIFICATIONS_PER_RUN = 5;",
      "const MAX_NOTIFICATIONS_PER_RUN = 12;",
    );
    // メッセージを 4000 字にして 1 チャンク = 1 記事にし、12 記事を 5 + 5 + 2 の
    // 3 push に分ける（LINE_MAX_MESSAGES_PER_PUSH = 5 のまま）
    const items = rawItems(12).map((it) => ({ ...it, title: it.title + "x".repeat(4000) }));
    const { api, get } = loadGas({ properties: LINE_SETUP, fetch, root: () => rss(items), source });
    const titles = () => items.map((it) => it.title);

    // 1 回目: push#1（記事 1〜5）は届く。push#2（記事 6〜10）が 500 → 例外で catch へ
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(titles().slice(0, 5));
    expect(pushCount).toBe(2);

    // 届いた 5 件だけが既読に入る
    expect(JSON.parse(get("seenIds:" + FEED))).toEqual(rawItems(5).map((it) => it.guid));

    // 2 回目: 記事 6〜12 だけが再送される（1 チャンク目は再送されない）
    failOnce = false;
    pushCount = 0;
    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(titles().slice(5));
    expect(JSON.parse(get("seenIds:" + FEED)).length).toBe(12);
  });

  test("移行: lastSeen だけがあるインストールは既存記事を再通知せず、以降の新着は通知する", () => {
    const captured = [];
    const items = rawItems(3);
    const { api, get } = loadGas({
      properties: { ...LINE_SETUP, ["lastSeen:" + FEED]: "2026-09-03T00:00:00.000Z" },
      fetch: okFetch(captured),
      root: () => rss(items),
    });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]); // lastSeen 以前の記事は既読として引き継がれる
    expect(JSON.parse(get("seenIds:" + FEED))).toEqual(["a1", "a2", "a3"]);

    items.push({ title: "A4", link: `${FEED}/4`, guid: "a4", pubDate: "Fri, 04 Sep 2026 00:00:00 GMT" });
    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A4"]);
  });
});

describe("parseAtom の ID", () => {
  const entry = (title, id, href) =>
    el("entry", "", [
      el("title", title),
      el("id", id),
      el("link", "", [], { rel: "alternate", href }),
    ]);

  test("<id> が空文字なら link / title にフォールバックする（ID が衝突しない）", () => {
    const root = el("feed", "", [
      entry("T1", "", "https://example.com/1"),
      entry("T2", "", "https://example.com/2"),
    ]);
    const { api } = loadGas({ root, fetch: okFetch() });
    expect(api.fetchFeedItems(FEED).map((it) => it.id)).toEqual([
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });
});

// 6868457 で embed.url に入れないようにした Moody Blues Atom は相対 href
// （<link href="/blog/x"/>）のままで、通知のタイトルがクリックできないままだった。
// フィード URL を基準に絶対化してから通知する。
describe("resolveLink: 記事リンクの絶対 URL 解決", () => {
  const ATOM_FEED = "https://www.moodyblues.com/rss/blog-entries.xml";

  test("相対 href はフィード URL を基準に絶対 URL になる（Atom）", () => {
    const entry = (title, href) =>
      el("entry", "", [
        el("title", title),
        el("id", "id-" + title),
        el("link", "", [], { rel: "alternate", href }),
      ]);
    const root = el("feed", "", [
      entry("ルート相対", "/blog/entries/1.aspx"),
      entry("ディレクトリ相対", "2.aspx"),
      entry("上位へ", "../other/3.aspx"),
      entry("絶対 URL", "https://example.com/4"),
    ]);
    const { api } = loadGas({ root, fetch: okFetch() });
    expect(api.fetchFeedItems(ATOM_FEED).map((it) => it.link)).toEqual([
      "https://www.moodyblues.com/blog/entries/1.aspx",
      "https://www.moodyblues.com/rss/2.aspx",
      "https://www.moodyblues.com/other/3.aspx",
      "https://example.com/4",
    ]);
  });

  test("相対 link はフィード URL を基準に絶対 URL になる（RSS）", () => {
    const root = rss([
      { title: "相対", link: "/blog/1", guid: "g1" },
      { title: "なし", guid: "g2" },
    ]);
    const { api } = loadGas({ root, fetch: okFetch() });
    expect(api.fetchFeedItems(ATOM_FEED).map((it) => it.link)).toEqual([
      "https://www.moodyblues.com/blog/1",
      "",
    ]);
  });

  test("絶対 URL はそのまま、空文字は空文字、スキーマ相対は feedUrl のスキーマを継ぐ", () => {
    const { api } = loadGas();
    const f = (link, feed) => api.resolveLink(link, feed);
    expect(f("https://example.com/1", ATOM_FEED)).toBe("https://example.com/1");
    expect(f("/blog/x", ATOM_FEED)).toBe("https://www.moodyblues.com/blog/x");
    expect(f("//cdn.example.com/x", ATOM_FEED)).toBe("https://cdn.example.com/x");
    expect(f("", ATOM_FEED)).toBe("");
    expect(f("   ", ATOM_FEED)).toBe("");
    // feedUrl が http(s) でなければ解決せず元の値を返す
    expect(f("/blog/x", "ftp://example.com/f")).toBe("/blog/x");
    expect(f("/blog/x", "")).toBe("/blog/x");
  });

  test("解決後の URL は LINE 通知の本文にも出る", () => {
    const captured = [];
    const root = rss([
      { title: "相対", link: "/blog/1", guid: "g1", pubDate: "Tue, 15 Sep 2026 09:00:00 GMT" },
    ]);
    const { api } = loadGas({ properties: LINE_SETUP, fetch: okFetch(captured), root });
    api.processFeed(ATOM_FEED);
    const texts = captured
      .filter((c) => c.url === LINE_PUSH_URL)
      .flatMap((c) => JSON.parse(c.params.payload).messages.map((m) => m.text));
    expect(texts[0]).toContain("- リンク: https://www.moodyblues.com/blog/1");
  });
});

describe("parseSeenIds / selectNewItems / mergeSeenIds", () => {
  test("parseSeenIds は壊れた値・非配列を空配列として扱う", () => {
    const { api } = loadGas();
    expect(api.parseSeenIds('["a","b"]')).toEqual(["a", "b"]);
    expect(api.parseSeenIds("{壊れた JSON")).toEqual([]);
    expect(api.parseSeenIds("")).toEqual([]);
    expect(api.parseSeenIds(null)).toEqual([]);
  });

  test("selectNewItems は既読 ID の記事を除く", () => {
    const { api } = loadGas();
    const items = [{ id: "x" }, { id: "y" }, { id: "z" }];
    expect(api.selectNewItems(items, ["y"]).map((it) => it.id)).toEqual(["x", "z"]);
    expect(api.selectNewItems(items, []).length).toBe(3);
    expect(api.selectNewItems(items, ["x", "y", "z"])).toEqual([]);
  });

  test("mergeSeenIds は重複を畳み込み、直近 50 件に切り詰める", () => {
    const { api } = loadGas();
    expect(api.mergeSeenIds(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);

    const sixty = Array.from({ length: 60 }, (_, i) => `id${i}`);
    const merged = api.mergeSeenIds([], sixty);
    expect(merged.length).toBe(50); // Script Properties の 1 値あたりのサイズ上限に対する余裕
    expect(merged[0]).toBe("id10");
    expect(merged[49]).toBe("id59");
  });

  test("mergeSeenIds は長い ID でも JSON を保存上限内に収める（新しい方を残す）", () => {
    const { api } = loadGas();
    // 1 件 300 字超 × 50 件 = 16KB 超。Script Properties の 1 値 9KB 制限に収める必要がある
    const longIds = Array.from({ length: 50 }, (_, i) => `https://example.com/${i}/` + "a".repeat(300));
    const merged = api.mergeSeenIds([], longIds);
    expect(JSON.stringify(merged).length).toBeLessThanOrEqual(6000);
    expect(merged[merged.length - 1]).toBe(longIds[49]);
    expect(merged.length).toBeGreaterThan(0);
  });
});

