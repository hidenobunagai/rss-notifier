// Code.js（GAS）の純関数と選別ロジックのテスト。
// GAS API はガスハーネスが差し替えるので、bun test からそのまま呼べる。
import { describe, expect, test } from "bun:test";
import { el, loadGas, okFetch, rss } from "./gas-harness.js";

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

describe("buildDiscordPayload", () => {
  test("300 字の title は 256 字（255 字 + …）に丸める", () => {
    const { api } = loadGas();
    const payload = api.buildDiscordPayload({ title: "あ".repeat(300), link: "", date: new Date(0) }, FEED);
    const title = payload.embeds[0].title;
    expect(title.length).toBe(256); // Discord の embed title 上限
    expect(title).toBe("あ".repeat(255) + "…");
  });

  test("上限以内の title はそのまま", () => {
    const { api } = loadGas();
    const payload = api.buildDiscordPayload({ title: "短いタイトル", link: "", date: new Date(0) }, FEED);
    expect(payload.embeds[0].title).toBe("短いタイトル");
  });

  test("相対リンクには url を付けない（Discord が 400 にするため）", () => {
    const { api } = loadGas();
    for (const link of ["/blog/relative", "../post/1", "example.com/x", ""]) {
      const embed = api.buildDiscordPayload({ title: "t", link, date: new Date(0) }, FEED).embeds[0];
      expect("url" in embed).toBe(false);
    }
  });

  test("絶対 http(s) URL は url に入り、2048 字超は落とす", () => {
    const { api } = loadGas();
    const ok = api.buildDiscordPayload({ title: "t", link: "https://example.com/1", date: new Date(0) }, FEED);
    expect(ok.embeds[0].url).toBe("https://example.com/1");
    expect(ok.embeds[0].footer.text).toBe(FEED);
    expect(ok.username).toBe("RSS Notifier");
    expect(ok.allowed_mentions).toEqual({ parse: [] });

    const tooLong = "https://example.com/" + "a".repeat(2048);
    expect("url" in api.buildDiscordPayload({ title: "t", link: tooLong, date: new Date(0) }, FEED).embeds[0]).toBe(false);
  });

  test("日時が無い記事には timestamp を付けない", () => {
    const { api } = loadGas();
    const embed = api.buildDiscordPayload({ title: "t", link: "", date: new Date(0) }, FEED).embeds[0];
    expect("timestamp" in embed).toBe(false);
  });

  test("processFeed 経由でも上限内の payload が送られる", () => {
    const captured = [];
    const root = rss([
      { title: "あ".repeat(300), link: "/blog/relative", guid: "long1", pubDate: "Tue, 15 Sep 2026 09:00:00 GMT" },
    ]);
    const { api } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });
    api.processFeed(FEED);

    const embed = JSON.parse(captured.find((c) => c.url === WEBHOOK).params.payload).embeds[0];
    expect(embed.title.length).toBe(256);
    expect("url" in embed).toBe(false);
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
    const { api, get } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });

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
      properties: DISCORD_SETUP,
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

  test("③ 同日時の記事が 1 件失敗しても、次回の実行でリトライされる", () => {
    const captured = [];
    let attempts = [];
    let failC2 = true;
    const sameDate = "Tue, 15 Sep 2026 09:00:00 GMT";
    const root = rss(
      ["C1", "C2", "C3", "C4"].map((t) => ({ title: t, link: `${FEED}/${t}`, pubDate: sameDate })),
    );
    const fetch = (url, params) => {
      const title = params?.payload ? JSON.parse(params.payload).embeds[0].title : null;
      if (title) attempts.push(title);
      const code = title === "C2" && failC2 ? 500 : 200;
      if (code < 400) captured.push({ url, params }); // 成功した送信だけを記録する
      return { getResponseCode: () => code, getContentText: () => "", getHeaders: () => ({}) };
    };
    const { api } = loadGas({ properties: DISCORD_SETUP, fetch, root });

    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["C1", "C3", "C4"]); // C2 だけ失敗

    failC2 = false;
    captured.length = 0;
    attempts = [];
    api.processFeed(FEED);
    expect(attempts).toEqual(["C2"]); // 失敗した C2 だけが再送される
    expect(sentTitles(captured)).toEqual(["C2"]);
  });

  test("同じ記事は 2 度通知されない（通常経路）", () => {
    const captured = [];
    const root = rss(rawItems(3));
    const { api, get } = loadGas({ properties: DISCORD_SETUP, fetch: okFetch(captured), root });
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual(["A1", "A2", "A3"]);
    expect(JSON.parse(get("seenIds:" + FEED))).toEqual(["a1", "a2", "a3"]);

    captured.length = 0;
    api.processFeed(FEED);
    expect(sentTitles(captured)).toEqual([]);
  });

  test("移行: lastSeen だけがあるインストールは既存記事を再通知せず、以降の新着は通知する", () => {
    const captured = [];
    const items = rawItems(3);
    const { api, get } = loadGas({
      properties: { ...DISCORD_SETUP, ["lastSeen:" + FEED]: "2026-09-03T00:00:00.000Z" },
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

