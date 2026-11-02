import { describe, expect, it } from "vitest";
import { cardKey, dataForTrack } from "../src/card.ts";
import { demoCard } from "../src/demo.ts";
import type { NowPlaying } from "../src/model.ts";
import { CALL_BUDGET, MAX_LOOKBACK, addDays, dayLetters, dayStart, fetchDayCount, localDay, refreshWeek, streakOf, summarise, zoneOf } from "../src/week.ts";

const IST = "Asia/Kolkata";
/** 2026-11-02, 10:00 in India. */
const NOW = Date.UTC(2026, 10, 2, 4, 30);

describe("days in the listener's own timezone", () => {
  it("counts a play just after midnight in India as the next day, not the UTC day it is still", () => {
    expect(localDay(Date.UTC(2026, 10, 1, 19, 0), IST)).toBe("2026-11-02"); // 00:30 in India, 19:00 UTC the day before
    expect(localDay(Date.UTC(2026, 10, 1, 19, 0), "UTC")).toBe("2026-11-01");
  });

  it("starts a day at local midnight, whatever the offset", () => {
    expect(dayStart("2026-11-02", IST)).toBe(Date.UTC(2026, 10, 1, 18, 30) / 1000);
    expect(dayStart("2026-11-02", "UTC")).toBe(Date.UTC(2026, 10, 2) / 1000);
    expect(dayStart("2026-11-02", "America/Los_Angeles")).toBe(Date.UTC(2026, 10, 2, 8) / 1000); // winter time since 1 November
  });

  it("gets the day after a clock change right, so it is 23 or 25 hours long", () => {
    const ny = "America/New_York";
    const spring = dayStart("2026-03-09", ny) - dayStart("2026-03-08", ny); // clocks go forward on the 8th
    const autumn = dayStart("2026-11-02", ny) - dayStart("2026-11-01", ny); // and back on 1 November
    expect(spring / 3600).toBe(23);
    expect(autumn / 3600).toBe(25);
  });

  it("names the weekdays of the seven days ending on a date, oldest first", () => {
    expect(dayLetters("2026-11-02").join("")).toBe("TWTFSSM"); // a Monday
    expect(dayLetters("2026-11-08").join("")).toBe("MTWTFSS"); // a Sunday
    expect(dayLetters("2026-03-02").join("")).toBe("TWTFSSM"); // across the end of February
  });

  it("does plain calendar arithmetic on dates", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-11-02", -6)).toBe("2026-10-27");
  });

  it("falls back to UTC for a timezone it does not know, or none", () => {
    expect(zoneOf("Mars/Olympus")).toBe("UTC");
    expect(zoneOf(undefined)).toBe("UTC");
    expect(zoneOf("  ")).toBe("UTC");
    expect(zoneOf(" Asia/Kolkata ")).toBe("Asia/Kolkata");
  });
});

describe("the week's figures", () => {
  const days = (list: Record<string, number>) => list;

  it("lists seven days, oldest first, with today last, and totals them", () => {
    const w = summarise(days({ "2026-10-27": 1, "2026-10-28": 2, "2026-10-29": 3, "2026-10-30": 4, "2026-10-31": 5, "2026-11-01": 6, "2026-11-02": 7 }), "2026-11-02", 5)!;
    expect(w.bars).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(w.total).toBe(28);
    expect(w.day).toBe("2026-11-02");
  });

  it("is not worked out while a day of the week is unknown, rather than drawing a gap as a zero", () => {
    expect(summarise(days({ "2026-11-02": 7 }), "2026-11-02", 0)).toBeNull();
  });

  it("counts a streak back from today", () => {
    expect(streakOf(days({ "2026-11-02": 2, "2026-11-01": 1, "2026-10-31": 4, "2026-10-30": 0, "2026-10-29": 9 }), "2026-11-02")).toBe(3);
  });

  it("does not break the streak just because today has no play yet", () => {
    expect(streakOf(days({ "2026-11-02": 0, "2026-11-01": 1, "2026-10-31": 4, "2026-10-30": 0 }), "2026-11-02")).toBe(2);
  });

  it("is 0 when neither today nor yesterday has a play, and stops at a day not known", () => {
    expect(streakOf(days({ "2026-11-02": 0, "2026-11-01": 0, "2026-10-31": 5 }), "2026-11-02")).toBe(0);
    expect(streakOf(days({ "2026-11-02": 1 }), "2026-11-02")).toBe(1);
  });
});

/** A Last.fm that knows plays per day, and answers like the real one: the total of the range, one track in the page. */
function lastfm(perDay: Record<string, number>, tz = IST) {
  const asked: string[] = [];
  const byStart = new Map(Object.entries(perDay).map(([day, n]) => [String(dayStart(day, tz)), n]));
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const from = url.searchParams.get("from") ?? "";
    const to = Number(url.searchParams.get("to"));
    asked.push(from);
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("method")).toBe("user.getrecenttracks");
    // The day is exactly one local day: it ends a second before the next one starts.
    const day = [...byStart.keys()].includes(from) ? from : "";
    if (day) expect(to).toBe(Number(from) + 86400 - 1);
    return Response.json({ recenttracks: { "@attr": { total: String(byStart.get(from) ?? 0) } } });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe("working out the week from Last.fm", () => {
  /** The same count every day, for as far back as anyone looks. */
  const ten = (n: number) => Object.fromEntries(Array.from({ length: MAX_LOOKBACK + 10 }, (_, i) => [addDays("2026-11-02", -i), n]));

  /** Two plays a day for the week up to 2 November, and none before it, so the streak is short and stops. */
  const week2 = () => ({ ...ten(0), ...Object.fromEntries(Array.from({ length: 7 }, (_, i) => [addDays("2026-11-02", -i), 2])) });

  it("asks once for each of the seven days, then reaches back for the streak", async () => {
    const perDay = { ...ten(0), "2026-11-02": 3, "2026-11-01": 8, "2026-10-31": 5, "2026-10-30": 1, "2026-10-29": 2, "2026-10-28": 6, "2026-10-27": 4, "2026-10-26": 2, "2026-10-25": 1 };
    const { fetcher, asked } = lastfm(perDay);
    const out = (await refreshWeek({}, "u", "k", IST, NOW, fetcher))!;
    expect(out.week.bars).toEqual([4, 6, 2, 1, 5, 8, 3]);
    expect(out.week.total).toBe(29);
    expect(out.week.streak).toBe(9); // two more days beyond the week, then a day with none
    expect(out.week.day).toBe("2026-11-02");
    expect(asked.length).toBeLessThanOrEqual(CALL_BUDGET);
    expect(new Set(asked).size).toBe(asked.length); // never the same day twice
    expect(out.days["2026-10-25"]).toBe(1);
  });

  it("keeps finished days and asks again only for today and yesterday", async () => {
    const perDay = { ...week2(), "2026-11-02": 3 };
    const first = lastfm(perDay);
    const out = (await refreshWeek({}, "u", "k", IST, NOW, first.fetcher))!;
    const second = lastfm({ ...perDay, "2026-11-02": 4 });
    const again = (await refreshWeek(out.days, "u", "k", IST, NOW + 3_600_000, second.fetcher))!;
    expect(second.asked.sort()).toEqual([String(dayStart("2026-11-01", IST)), String(dayStart("2026-11-02", IST))].sort());
    expect(again.week.bars[6]).toBe(4);
  });

  it("moves on a day when the listener's date turns over, asking for the new day and keeping the rest", async () => {
    const perDay = { ...week2(), "2026-11-03": 6 };
    const out = (await refreshWeek({}, "u", "k", IST, NOW, lastfm(perDay).fetcher))!;
    const next = lastfm(perDay);
    const later = (await refreshWeek(out.days, "u", "k", IST, Date.UTC(2026, 10, 3, 4, 30), next.fetcher))!;
    expect(later.week.day).toBe("2026-11-03");
    expect(later.week.bars).toEqual([2, 2, 2, 2, 2, 2, 6]);
    expect(next.asked).toHaveLength(2);
  });

  it("stays within its call budget however long the streak runs, and never looks past the lookback", async () => {
    const { fetcher, asked } = lastfm(ten(1));
    const out = (await refreshWeek({}, "u", "k", IST, NOW, fetcher))!;
    expect(asked.length).toBeLessThanOrEqual(CALL_BUDGET);
    expect(out.week.streak).toBeGreaterThanOrEqual(7);
    expect(out.week.streak).toBeLessThanOrEqual(MAX_LOOKBACK);
    // The next refresh carries on from what is kept, so the streak grows by what the budget allows.
    const more = lastfm(ten(1));
    const again = (await refreshWeek(out.days, "u", "k", IST, NOW + 3_600_000, more.fetcher))!;
    expect(again.week.streak).toBeGreaterThan(out.week.streak);
  });

  it("gives nothing, so the card keeps what it showed, when a day of the week cannot be fetched", async () => {
    const down = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    expect(await refreshWeek({}, "u", "k", IST, NOW, down)).toBeNull();
    const broken = (async () => Response.json({ error: 8 })) as typeof fetch;
    expect(await refreshWeek({}, "u", "k", IST, NOW, broken)).toBeNull();
    const thrown = (async () => { throw new Error("offline"); }) as typeof fetch;
    expect(await refreshWeek({}, "u", "k", IST, NOW, thrown)).toBeNull();
  });

  it("forgets days older than four months", async () => {
    const old = { "2026-03-01": 5, "2026-07-10": 5 };
    const out = (await refreshWeek(old, "u", "k", IST, NOW, lastfm(ten(1)).fetcher))!;
    expect(out.days["2026-03-01"]).toBeUndefined();
    expect(out.days["2026-07-10"]).toBe(5);
  });

  it("reads one day's total, and nothing from an answer it cannot trust", async () => {
    expect(await fetchDayCount("u", "k", 1, 2, (async () => Response.json({ recenttracks: { "@attr": { total: "17" } } })) as typeof fetch)).toBe(17);
    expect(await fetchDayCount("u", "k", 1, 2, (async () => Response.json({ recenttracks: {} })) as typeof fetch)).toBeNull();
    expect(await fetchDayCount("u", "k", 1, 2, (async () => Response.json({ recenttracks: { "@attr": { total: "-3" } } })) as typeof fetch)).toBeNull();
    expect(await fetchDayCount("u", "k", 1, 2, (async () => new Response("<html>", { status: 200 })) as typeof fetch)).toBeNull();
  });
});

describe("the week in the card's data", () => {
  const np = (status: "idle" | "playing"): NowPlaying => ({ user: "u", status, track: { title: "T", artist: "A", album: "B", artUrl: null, playedAt: status === "idle" ? 1700000000 : null } });
  const week = (over = {}) => ({ bars: [0, 5, 2, 9, 4, 8, 3], total: 31, streak: 6, day: "2026-11-02", at: 1, ...over });

  it("is on the card of a song that is not playing, and only the figures the card draws", () => {
    expect(dataForTrack(np("idle"), null, 0, undefined, week()).data.week).toEqual({ bars: [0, 5, 2, 9, 4, 8, 3], total: 31, streak: 6, day: "2026-11-02" });
  });

  it("is left off a playing card, and off a week with no plays", () => {
    expect(dataForTrack(np("playing"), null, 0, undefined, week()).data.week).toBeUndefined();
    expect(dataForTrack(np("idle"), null, 0, undefined, week({ bars: [0, 0, 0, 0, 0, 0, 0], total: 0, streak: 0 })).data.week).toBeUndefined();
    expect(dataForTrack(np("idle"), null, 0).data.week).toBeUndefined();
  });

  it("moves the card's key when a bar or the streak changes, so an open page swaps the card, and not when nothing did", () => {
    const key = (w?: ReturnType<typeof week>) => cardKey(dataForTrack(np("idle"), null, 0, undefined, w).data);
    expect(key(week())).toBe(key(week({ at: 999 }))); // only what is drawn counts
    expect(key(week())).not.toBe(key(week({ day: "2026-11-03" }))); // a new day changes the letters
    expect(key(week())).not.toBe(key(week({ bars: [0, 5, 2, 9, 4, 8, 4], total: 32 })));
    expect(key(week())).not.toBe(key(week({ streak: 7 })));
    expect(key(week())).not.toBe(key(undefined));
  });

  it("is in the idle demo, with the streak it shows", () => {
    const d = demoCard("idle", 1_700_000_000).data;
    expect(d.week).toMatchObject({ total: 31, streak: 6 });
    expect(d.week!.bars).toHaveLength(7);
    expect(demoCard("playing", 1_700_000_000).data.week).toBeUndefined();
  });
});
