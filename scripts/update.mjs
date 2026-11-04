// =====================================================================
// VTrend Base データ更新スクリプト
// YouTube Data API v3（無料枠）から日本のトレンドを取得し、data.json を作る。
// GitHub Actions が毎日0時過ぎ（日本時間）に自動実行する。
// 1回の実行で使うのは約6,500ユニット（無料枠は1日10,000ユニット）。
// ※ 無料枠は太平洋時間0時（日本時間16時〜17時）にリセット。同じ枠内で手動実行を重ねると足りなくなるので注意。
// =====================================================================
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error('環境変数 YT_API_KEY が設定されていません'); process.exit(1); }
const OUT = new URL('../data.json', import.meta.url);

// index.html の GENRES と同じ内容にしておくこと
const GENRES = [
  { id: 'all',   kw: '',           cat: null },
  { id: 'game',  kw: 'ゲーム実況', cat: '20' },
  { id: 'song',  kw: '歌ってみた', cat: '10' },
  { id: 'talk',  kw: '雑談',       cat: null },
  { id: 'plan',  kw: '企画',       cat: null },
];
const PERIODS = [1, 7, 30];
const VPARTS = 'snippet,statistics,contentDetails,liveStreamingDetails';
const isChart = (g, vtOnly) => !vtOnly && (g.id === 'all' || !!g.cat);
const isoDur = s => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };

let units = 0;
async function yt(path, params, cost) {
  const url = `https://www.googleapis.com/youtube/v3/${path}?` + new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(url);
  const json = await res.json();
  units += cost;
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}

// 前回のデータ（失敗時の予備・登録者推移の引き継ぎ用）
let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }

const now = Date.now();
const sets = {};
const raw = {};          // videoId -> API の生データ
const fromPrev = {};     // 取得に失敗して前回分を使う動画

async function fetchVideos(ids) {
  const missing = ids.filter(id => !raw[id]);
  for (let i = 0; i < missing.length; i += 50) {
    const j = await yt('videos', { part: VPARTS, id: missing.slice(i, i + 50).join(',') }, 1);
    for (const it of j.items || []) raw[it.id] = it;
  }
}

for (const vtOnly of [true, false]) {
  for (const g of GENRES) {
    const periods = isChart(g, vtOnly) ? ['chart'] : PERIODS;
    for (const p of periods) {
      const key = [g.id, p, vtOnly ? 1 : 0].join('|');
      try {
        if (p === 'chart') {
          const params = { part: VPARTS, chart: 'mostPopular', regionCode: 'JP', maxResults: 50 };
          if (g.cat) params.videoCategoryId = g.cat;
          const j = await yt('videos', params, 1);
          for (const it of j.items || []) raw[it.id] = it;
          sets[key] = (j.items || []).map(i => i.id);
        } else {
          const q = [vtOnly ? 'VTuber' : '', g.kw].filter(Boolean).join(' ') || 'VTuber';
          const base = {
            part: 'snippet', type: 'video', regionCode: 'JP', relevanceLanguage: 'ja', order: 'viewCount',
            publishedAfter: new Date(now - p * 864e5).toISOString(), maxResults: 50, q,
          };
          // 「動画・配信・ショート」の形式フィルター用に、通常／配信アーカイブ／ショートを別々に検索して合体
          const variants = [{}, { eventType: 'completed' }, { videoDuration: 'short' }];
          const ids = [];
          for (const extra of variants) {
            const j = await yt('search', { ...base, ...extra }, 100);
            for (const i of j.items || []) {
              const id = i.id && i.id.videoId;
              if (id && !ids.includes(id)) ids.push(id);
            }
          }
          await fetchVideos(ids);
          sets[key] = ids.filter(id => raw[id]);
        }
        console.log(`OK   ${key}: ${sets[key].length}件`);
      } catch (e) {
        console.warn(`FAIL ${key}: ${e.message}（前回のデータを使います）`);
        if (prev.sets && prev.sets[key]) {
          sets[key] = prev.sets[key];
          for (const id of sets[key]) if (!raw[id] && prev.videos && prev.videos[id]) fromPrev[id] = prev.videos[id];
        }
      }
    }
  }
}

// チャンネル登録者数（50件ずつ）
const chIds = [...new Set(Object.values(raw).map(v => v.snippet.channelId))];
const subsNow = {};
for (let i = 0; i < chIds.length; i += 50) {
  try {
    const j = await yt('channels', { part: 'statistics', id: chIds.slice(i, i + 50).join(',') }, 1);
    for (const c of j.items || []) subsNow[c.id] = c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount;
  } catch (e) { console.warn(`FAIL channels: ${e.message}`); }
}

// 出力用に整形
const videos = { ...fromPrev };
for (const [id, it] of Object.entries(raw)) {
  const t = it.snippet.thumbnails || {};
  const st = it.statistics || {};
  const live = it.liveStreamingDetails && it.liveStreamingDetails.concurrentViewers;
  videos[id] = {
    id,
    title: it.snippet.title,
    ch: it.snippet.channelTitle,
    chId: it.snippet.channelId,
    subs: subsNow[it.snippet.channelId] ?? null,
    views: +(st.viewCount || 0),
    likes: +(st.likeCount || 0),
    comments: +(st.commentCount || 0),
    published: it.snippet.publishedAt,
    dur: isoDur(it.contentDetails && it.contentDetails.duration),
    thumb: (t.medium || t.default || {}).url || '',
    live: live ? +live : null,
    stream: !!it.liveStreamingDetails, // ライブ配信（アーカイブ・配信中・予定）なら true
  };
}

// 登録者推移：日本時間の日付ごとに1点、最大30日分
const day = new Date(now + 9 * 3600e3).toISOString().slice(0, 10);
const subs = {};
const usedCh = new Set(Object.values(videos).map(v => v.chId));
for (const id of usedCh) {
  const h = ((prev.subs && prev.subs[id]) || []).slice();
  if (subsNow[id] != null) {
    if (h.length && h[h.length - 1].d === day) h[h.length - 1].n = subsNow[id];
    else h.push({ d: day, n: subsNow[id] });
  }
  if (h.length) subs[id] = h.slice(-30);
}

const out = { updated: new Date(now).toISOString(), units, sets, videos, subs };
await writeFile(OUT, JSON.stringify(out));
console.log(`完了: 動画${Object.keys(videos).length}本 / チャンネル${Object.keys(subs).length} / 使用ユニット 約${units}`);
