/**
 * How the listener's last week went: plays per day for the idle card's little bar chart, and the current streak of days
 * with at least one play. Days are the listener's own (TIMEZONE), not UTC, so a late-night play counts for that night.
 *
 * Each day is one cheap Last.fm call (a one-track page of that day's scrobbles; the answer is the total). Days that are
 * over never change, so they are asked once and kept; only today and yesterday are asked again at each refresh.
 */

const API = "https://ws.audioscrobbler.com/2.0/";

export interface WeekStats {
  /** Plays per day, oldest first; the last entry is today. Always 7 long. */
  bars: number[];
  /** Plays over those seven days. */
  total: number;
  /** Days in a row, ending today (or yesterday, while today has no play yet), that have at least one play. */
  streak: number;
  /** The listener's date when this was worked out ("2026-11-02"), so a new day is noticed. */
  day: string;
  /** Milliseconds when this was worked out. */
  at: number;
}

/** Counts per day, keyed by the listener's date. */
export type DayCounts = Record<string, number>;

/** The streak is never looked up further back than this many days. */
export const MAX_LOOKBACK = 90;
/** Most Last.fm calls one refresh makes, kept well under a Worker's limit on outgoing requests. */
export const CALL_BUDGET = 24;
/** Days older than this are dropped from what is kept. */
const KEEP_DAYS = 120;

/** A valid IANA timezone name, or UTC. */
export function zoneOf(tz: string | undefined): string {
  const name = tz?.trim();
  if (!name) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return "UTC";
  }
}

/** The listener's date at this moment: "YYYY-MM-DD". */
export function localDay(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** The year, month and day of a "YYYY-MM-DD" date. */
const parts = (day: string): [number, number, number] => {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
};

/** The date `n` days before (negative: after) a "YYYY-MM-DD" date. Calendar arithmetic only, so no clock changes matter. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** How far a timezone is ahead of UTC at a moment, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  const p: Record<string, number> = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, p.hour ?? 0, p.minute ?? 0, p.second ?? 0) - Math.floor(ms / 1000) * 1000;
}

/** Unix seconds when a listener's date begins in their timezone. Settles twice so a clock change near midnight lands right. */
export function dayStart(day: string, tz: string): number {
  const [y, m, d] = parts(day);
  const utc = Date.UTC(y, m - 1, d);
  let t = utc - offsetAt(utc, tz);
  t = utc - offsetAt(t, tz);
  return Math.floor(t / 1000);
}

/** The week's figures from the counts kept so far, or null while any of the seven days is still unknown. */
export function summarise(days: DayCounts, today: string, at: number): WeekStats | null {
  const bars: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const n = days[addDays(today, -i)];
    if (n === undefined) return null;
    bars.push(n);
  }
  return { bars, total: bars.reduce((a, b) => a + b, 0), streak: streakOf(days, today), day: today, at };
}

/** Days in a row with a play, counting back from today, or from yesterday while today has none yet. */
export function streakOf(days: DayCounts, today: string): number {
  let cursor = (days[today] ?? 0) > 0 ? today : addDays(today, -1);
  let n = 0;
  while (n < MAX_LOOKBACK && (days[cursor] ?? 0) > 0) {
    n++;
    cursor = addDays(cursor, -1);
  }
  return n;
}

/** One day's play count from Last.fm: the total of a page of one, between two Unix times. Null when it cannot be told. */
export async function fetchDayCount(user: string, apiKey: string, from: number, to: number, fetcher: typeof fetch = fetch): Promise<number | null> {
  const url = `${API}?method=user.getrecenttracks&user=${encodeURIComponent(user)}&api_key=${apiKey}&format=json&limit=1&from=${from}&to=${to}`;
  try {
    const res = await fetcher(url, { headers: { "User-Agent": "Ode/0.1 (+github readme widget)" } });
    const json = (await res.json().catch(() => null)) as { error?: number; recenttracks?: { "@attr"?: { total?: string } } } | null;
    if (!json || json.error) return null;
    const total = Number(json.recenttracks?.["@attr"]?.total);
    return Number.isFinite(total) && total >= 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * Brings the kept day counts up to date and works out the week. Today and yesterday are asked again (a play can still land
 * on them); older days only when never asked. The streak reaches back past the week while the days keep having plays,
 * a week at a time, within the call budget. Returns null when a day needed for the bars could not be fetched, so the
 * caller keeps what it showed before.
 */
export async function refreshWeek(
  kept: DayCounts,
  user: string,
  apiKey: string,
  tz: string,
  nowMs: number,
  fetcher: typeof fetch = fetch,
): Promise<{ days: DayCounts; week: WeekStats } | null> {
  const days: DayCounts = { ...kept };
  const today = localDay(nowMs, tz);
  let calls = 0;
  let failed = false;

  const ask = async (list: string[]): Promise<void> => {
    const room = CALL_BUDGET - calls;
    const batch = list.slice(0, Math.max(0, room));
    calls += batch.length;
    await Promise.all(
      batch.map(async (day) => {
        const n = await fetchDayCount(user, apiKey, dayStart(day, tz), dayStart(addDays(day, 1), tz) - 1, fetcher);
        if (n === null) failed = true;
        else days[day] = n;
      }),
    );
  };

  const week = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  await ask(week.filter((d, i) => i < 2 || days[d] === undefined));
  if (failed) return null;

  // Reach back for the streak, a week at a time, while it is still running and the budget lasts.
  let cursor = (days[today] ?? 0) > 0 ? today : addDays(today, -1);
  for (let n = 0; n < MAX_LOOKBACK; ) {
    if ((days[cursor] ?? -1) > 0) {
      n++;
      cursor = addDays(cursor, -1);
      continue;
    }
    if (days[cursor] === undefined && calls < CALL_BUDGET) {
      await ask(Array.from({ length: 7 }, (_, i) => addDays(cursor, -i)).filter((d) => days[d] === undefined));
      if (failed) break; // what is known so far still gives a fair streak
      continue;
    }
    break;
  }

  const oldest = addDays(today, -KEEP_DAYS);
  for (const d of Object.keys(days)) if (d < oldest) delete days[d];
  const stats = summarise(days, today, nowMs);
  return stats ? { days, week: stats } : null;
}
