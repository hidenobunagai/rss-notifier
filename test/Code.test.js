// Code.js（GAS）の純関数と選別ロジックのテスト。
// GAS API はガスハーネスが差し替えるので、bun test からそのまま呼べる。
import { describe, expect, test } from "bun:test";
import { loadGas, okFetch, rss } from "./gas-harness.js";

const FEED = "https://example.com/feed";
const WEBHOOK = "https://discord.com/api/webhooks/1/token";
const DISCORD_SETUP = { discordWebhookUrl: WEBHOOK, feedUrls: JSON.stringify([FEED]) };

// Discord 投稿（webhook 宛）だけを拾い、記事タイトルの配列を返す
function sentTitles(captured) {
  return captured
    .filter((c) => c.url === WEBHOOK)
    .map((c) => JSON.parse(c.params.payload).embeds[0].title);
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
    api.postToLineInChunks("token", "target", messages);

    expect(captured.length).toBeGreaterThan(0);
    const texts = captured.flatMap((c) => JSON.parse(c.params.payload).messages.map((m) => m.text));
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(5000);
    for (const c of captured) {
      expect(JSON.parse(c.params.payload).messages.length).toBeLessThanOrEqual(5);
      expect(c.params.headers.Authorization).toBe("Bearer token");
    }
  });
});

// 以下は 2026-09-16 時点の既知の挙動を固定する特性テスト（backlog の「既読が日時 1 個の
// ウォーターマークなので 3 経路で記事が静かに消える」の実測 3 ケース）。ID ベースの既読に
// 変えるときは、この 3 本を意図的に書き換える（＝挙動変更に気づける）。
describe("processFeed: 既知の取りこぼし（特性テスト）", () => {
  const itemsOf = (n) =>
    Array.from({ length: n }, (_, i) => ({
      title: `A${i + 1}`,
      link: `${FEED}/${i + 1}`,
      guid: `a${i + 1}`,
      pubDate: `Tue, ${String(i + 1).padStart(2, "0")} Sep 2026 00:00:00 GMT`,
    }));

  test("① 一度に上限 5 件を超える新着が来ると、古い側は未通知のまま既読が進む", () => {
    const captured = [];
    const root = rss(itemsOf(10));
    const { api, get } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A6", "A7", "A8", "A9", "A10"]);
    // 既読は送信できた最新（A10）まで進む
    expect(get("lastSeen:" + FEED)).toBe("2026-09-10T00:00:00.000Z");

    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]); // A1〜A5 は二度と選ばれない
  });

  test("② pubDate が無いフィードは初回で lastSeen=1970-01-01 になり恒久沈黙する", () => {
    const captured = [];
    const root = rss([
      { title: "B1", link: `${FEED}/b1` },
      { title: "B2", link: `${FEED}/b2` },
      { title: "B3", link: `${FEED}/b3` },
    ]);
    const { api, get } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["B1", "B2", "B3"]);
    expect(get("lastSeen:" + FEED)).toBe("1970-01-01T00:00:00.000Z");

    captured.length = 0;
    api.processFeed(FEED); // B4 を足しても（同じく日付なし）0 件
    expect(sentTitles(captured)).toEqual([]);
  });

  test("③ 同日時の記事は 1 件失敗しても、成功した後続の日時で既読が進む", () => {
    const captured = [];
    const sameDate = "Tue, 15 Sep 2026 09:00:00 GMT";
    const root = rss(["C1", "C2", "C3", "C4"].map((t) => ({ title: t, link: `${FEED}/${t}`, pubDate: sameDate })));
    const fetch = (url, params) => {
      const title = params?.payload ? JSON.parse(params.payload).embeds[0].title : null;
      const code = title === "C2" ? 500 : 200; // C2 の投稿だけ失敗させる
      if (code < 400) captured.push({ url, params }); // 成功した送信だけを記録する
      return { getResponseCode: () => code, getContentText: () => "", getHeaders: () => ({}) };
    };
    const { api, get } = loadGas({ properties: DISCORD_SETUP, fetch, root });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["C1", "C3", "C4"]);
    expect(get("lastSeen:" + FEED)).toBe(new Date(sameDate).toISOString());

    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]); // C2 は永久に届かない
  });

  test("lastSeen より新しい記事だけが選別される（通常経路）", () => {
    const captured = [];
    const root = rss(itemsOf(3));
    const { api } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A1", "A2", "A3"]);
  });
});
