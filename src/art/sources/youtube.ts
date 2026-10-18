import type { Track } from "../../model.ts";
import { getBytes, json } from "../http.ts";
import { artFromJpeg, coverFromArtTrack } from "../image.ts";
import { core, norm, plainTitle, sameArtist, unescapeHtml } from "../match.ts";
import type { Loader } from "../types.ts";

interface YoutubeItem { id?: { videoId?: string; channelId?: string }; snippet?: { title?: string; channelTitle?: string; resourceId?: { videoId?: string } } }

const YT_API = "https://www.googleapis.com/youtube/v3";
const TOPIC = " - Topic";
/** Pages of 50 uploads read before falling back to one search inside the channel (1 unit a page, 100 a search). */
const UPLOAD_PAGES = 6;
const CHANNEL_TTL_MS = 7 * 86_400_000;
/** Different artists can share a name (five "Raanjha - Topic" channels exist), so a few are tried in turn. */
const CHANNELS_TRIED = 3;
const VIDEO_ID = /^[\w-]{11}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;

/**
 * Each artist's Topic channels, remembered so they are searched for once (a search costs 100 units). In memory: the
 * presence object lives for days, so this lasts; a restart only costs one search per artist again.
 */
const topicChannels = new Map<string, { ids: string[]; until: number }>();
/** For tests. */
export const resetTopicChannels = () => topicChannels.clear();

type Note = (detail: string) => void;

async function findTopicChannels(artist: string, apiKey: string, fetcher: typeof fetch, note: Note): Promise<string[]> {
  const k = norm(artist);
  const known = topicChannels.get(k);
  if (known && known.until > Date.now()) return note(`channels=${known.ids.length}`), known.ids;
  const q = new URLSearchParams({ part: "snippet", type: "channel", maxResults: "10", q: `${artist}${TOPIC}`, key: apiKey });
  const res = await json<{ items?: YoutubeItem[] }>(`${YT_API}/search?${q}`, fetcher);
  const ids = (res?.items ?? [])
    .filter((it) => {
      const title = unescapeHtml(it.snippet?.title ?? it.snippet?.channelTitle ?? "");
      return title.endsWith(TOPIC) && sameArtist(title.slice(0, -TOPIC.length), artist);
    })
    .map((it) => it.id?.channelId ?? "")
    .filter((id, i, all) => CHANNEL_ID.test(id) && all.indexOf(id) === i)
    .slice(0, CHANNELS_TRIED);
  topicChannels.set(k, { ids, until: Date.now() + CHANNEL_TTL_MS });
  note(`channels=${ids.length}/${res?.items?.length ?? 0}`);
  return ids;
}

/** The video id of this song among one Topic channel's uploads, or null. */
async function inTopicChannel(channel: string, track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch, note: Note): Promise<string | null> {
  const exact = norm(track.title);
  const wanted = core(track.title);
  const pick = (items: { id: string; title: string }[]) => {
    const same = items.filter((v) => VIDEO_ID.test(v.id) && core(v.title) === wanted);
    return same.find((v) => norm(v.title) === exact) ?? same[0];
  };

  let page: string | undefined;
  for (let i = 0; i < UPLOAD_PAGES; i++) {
    const q = new URLSearchParams({ part: "snippet", maxResults: "50", playlistId: `UU${channel.slice(2)}`, key: apiKey, ...(page ? { pageToken: page } : {}) });
    const res = await json<{ items?: YoutubeItem[]; nextPageToken?: string }>(`${YT_API}/playlistItems?${q}`, fetcher);
    const items = res?.items ?? [];
    note(`uploads=${items.length}`);
    // No uploads list at all (not every auto-generated channel exposes one): search inside the channel instead.
    if (i === 0 && items.length === 0) break;
    const hit = pick(items.map((it) => ({ id: it.snippet?.resourceId?.videoId ?? "", title: unescapeHtml(it.snippet?.title ?? "") })));
    if (hit) return hit.id;
    page = res?.nextPageToken;
    if (!page) return null; // read the whole catalogue: the song is not there
  }
  const q = new URLSearchParams({ part: "snippet", type: "video", maxResults: "10", channelId: channel, q: plainTitle(track.title) || track.title, key: apiKey });
  const res = await json<{ items?: YoutubeItem[] }>(`${YT_API}/search?${q}`, fetcher);
  note(`searched=${res?.items?.length ?? 0}`);
  return pick((res?.items ?? []).map((it) => ({ id: it.id?.videoId ?? "", title: unescapeHtml(it.snippet?.title ?? "") })))?.id ?? null;
}

const artTrackLoader = (id: string, fetcher: typeof fetch): Loader => async () => {
  const bytes = await getBytes(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, fetcher);
  const cover = bytes && coverFromArtTrack(bytes);
  const art = cover ? artFromJpeg(cover) : null;
  // The full HD frame holds the same cover at 720px; the site cuts it out.
  return art && { ...art, big: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, crop: "art-track" };
};

/**
 * YouTube Data API v3, official and keyed; it runs only when every other source has missed. Only auto-generated
 * "Artist - Topic" uploads are used: their picture is the label-supplied cover, which is why they cover so many
 * Indian and independent releases that Last.fm and Genius lack. Same artist, same song, as everywhere else.
 *
 * A plain search ranks the artist's own videos above the art track (measured: Shlovij's "vishwaroop darshan yog"
 * was not in the top 10), and costs 100 of the free 10,000 daily units. So: find the artist's Topic channels once,
 * then read their uploads (1 unit per 50) for the title; only a very long catalogue falls back to one search inside
 * the channel. A new song by a known artist costs a few units, so the free quota covers thousands a day.
 */
export async function fromYoutube(track: Pick<Track, "title" | "artist">, apiKey: string, fetcher: typeof fetch, note: Note = () => {}): Promise<Loader | null> {
  for (const channel of await findTopicChannels(track.artist, apiKey, fetcher, note)) {
    const found = await inTopicChannel(channel, track, apiKey, fetcher, note);
    if (found) return artTrackLoader(found, fetcher);
  }
  return null;
}
