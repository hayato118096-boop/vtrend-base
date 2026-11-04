// =====================================================================
// VTrend Base データ更新スクリプト（GitHub Actions が毎日0時過ぎ・日本時間に実行）
//
// ・YouTube Data API v3（無料枠）で「ジャンル × 形式（動画・配信・ショート）」ごとに動画を集める
//     期間は 7日 / 30日。切り抜き・歴代名作の計測も含めて1回の実行で約7,500ユニット（無料枠は1日10,000）
// ・新作ゲームは Steam ストアから取得（キー不要・YouTubeの枠は使わない）
//     ※ 無料枠は太平洋時間0時（日本時間16〜17時）にリセット。同じ枠内で通常の手動実行を重ねないこと
// ・動画タイトルから「話題ワード」を集計、YouTube検索候補・Googleトレンド（日本）も取得
// ・GEMINI_API_KEY があれば、Gemini（無料枠）で「伸びた理由」と解説動画の要約を作る
// ・AI_ONLY=true のときは YouTube のデータ取得をせず、前回のデータで AI の部分だけ作り直す
// =====================================================================
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error('環境変数 YT_API_KEY が設定されていません'); process.exit(1); }
const GEM = process.env.GEMINI_API_KEY || '';
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean);
const OUT = new URL('../data.json', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const GENRES = [
  { id: 'all',  kw: '',           sk: '' },
  { id: 'game', kw: 'ゲーム実況', sk: 'ゲーム' },
  { id: 'horror', kw: 'ホラーゲーム', sk: 'ホラゲ' },
  { id: 'song', kw: '歌ってみた', sk: '歌ってみた' },
  { id: 'talk', kw: '雑談',       sk: '雑談' },
  { id: 'plan', kw: '企画',       sk: '企画' },
];
const FORMATS = [
  { id: 'video',  extra: { videoDuration: 'medium' } },  // 4〜20分の投稿動画
  { id: 'stream', extra: { eventType: 'completed' } },   // 配信アーカイブ
  { id: 'short',  extra: { videoDuration: 'short' } },   // 4分未満 → 3分以内をショート扱い
];
// 解説ナレッジ記事ごとの「元動画」検索ワード（index.html の KNOW と id を合わせる）
const KNOW_SRC = {
  k1: 'Creator Insider YouTube algorithm explained',
  k2: 'Paddy Galloway YouTube audience retention',
  k3: 'Film Booth thumbnail title tips',
  k4: 'Colin and Samir packaging video ideas',
  k5: 'Jenny Hoyos YouTube shorts strategy',
  k6: 'vidIQ youtube shorts to long form',
  k7: 'Ali Abdaal youtube burnout',
  k8: 'how to grow as a VTuber tips',
};
const VPARTS = 'snippet,statistics,contentDetails,liveStreamingDetails';
const isoDur = s => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const now = Date.now();
const day = new Date(now + 9 * 3600e3).toISOString().slice(0, 10); // 日本時間の日付
const after = d => new Date(now - d * 864e5).toISOString();

// ---------------------------------------------------------------------
// YouTube API
// ---------------------------------------------------------------------
let units = 0;
async function yt(path, params, cost) {
  const url = `https://www.googleapis.com/youtube/v3/${path}?` + new URLSearchParams({ ...params, key: KEY });
  const res = await fetch(url);
  const json = await res.json();
  units += cost;
  if (json.error) throw new Error(`${path}: ${json.error.message}`);
  return json;
}
async function search(params, pages) {
  const ids = [];
  let token;
  for (let i = 0; i < pages; i++) {
    const j = await yt('search', token ? { ...params, pageToken: token } : params, 100);
    for (const it of j.items || []) { const id = it.id && it.id.videoId; if (id && !ids.includes(id)) ids.push(id); }
    token = j.nextPageToken;
    if (!token) break;
  }
  return ids;
}
const raw = {};
async function fetchVideos(ids) {
  const missing = ids.filter(id => !raw[id]);
  for (let i = 0; i < missing.length; i += 50) {
    const j = await yt('videos', { part: VPARTS, id: missing.slice(i, i + 50).join(',') }, 1);
    for (const it of j.items || []) raw[it.id] = it;
  }
}
// 日本の動画だけ残す：タイトルに日本語（かな・漢字）がある、または音声言語が日本語
const JA = /[぀-ヿ一-鿿]/;
const isJP = v => !!v && (JA.test(v.title || '') || /^ja/i.test(v.lang || ''));
const isClip = v => /切り抜き|切抜き|きりぬき|\bclips?\b/i.test((v.title || '') + ' ' + (v.ch || ''));
const fmtOf = it => {
  if (it.liveStreamingDetails) return 'stream';
  const d = isoDur(it.contentDetails && it.contentDetails.duration);
  return d > 0 && d <= 180 ? 'short' : 'video';
};

let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }
const AI_ONLY = process.env.AI_ONLY === 'true' && !!prev.pools;
if (AI_ONLY) console.log('AI_ONLY モード：YouTube のデータは前回のものを使い、AI の部分だけ作り直します');

let pools, videos, histDays, subs, tokens, tokHist, suggestOut, gtrends;
let steam = prev.steam || null, classic = prev.classic || {};

if (AI_ONLY) {
  ({ pools, videos, histDays, subs, tokens, tokHist, gtrends } = prev);
  suggestOut = prev.suggest;
  for (const k of Object.keys(pools)) pools[k] = pools[k].filter(id => isJP(videos[id]));
  for (const g of Object.keys(tokens || {})) tokens[g] = tokens[g].filter(t => JA.test(t.w) || t.top.some(id => isJP(videos[id])));
} else {
  // -------------------------------------------------------------------
  // 1. 動画プール：ジャンル × 形式 × (7日[2ページ] / 30日[1ページ] / 新着[1ページ])
  // -------------------------------------------------------------------
  pools = {};
  const keepPrev = new Set();
  // 「切り抜き」専用の検索も追加（切り抜きタブ用。動画・ショートのみ、新着なし）
  const POOL_GENRES = [...GENRES, { id: 'clip', kw: '切り抜き', formats: ['video', 'short'], noNew: true }];
  for (const g of POOL_GENRES) {
    for (const f of FORMATS) {
      if (g.formats && !g.formats.includes(f.id)) continue;
      const base = {
        part: 'snippet', type: 'video', regionCode: 'JP', relevanceLanguage: 'ja', maxResults: 50,
        q: ['VTuber', g.kw].filter(Boolean).join(' '), ...f.extra,
      };
      const jobs = [
        ['7',   { ...base, order: 'viewCount', publishedAfter: after(7) },  1],
        ['30',  { ...base, order: 'viewCount', publishedAfter: after(30) }, 1],
        ['new', { ...base, order: 'date',      publishedAfter: after(7) },  1], // 小規模チャンネル発掘用
      ].filter(j => !(g.noNew && j[0] === 'new'));
      for (const [p, params, pages] of jobs) {
        const key = `${g.id}|${f.id}|${p}`;
        try {
          const ids = await search(params, pages);
          await fetchVideos(ids);
          pools[key] = ids.filter(id => raw[id] && fmtOf(raw[id]) === f.id);
          console.log(`OK   ${key}: ${pools[key].length}件`);
        } catch (e) {
          console.warn(`FAIL ${key}: ${e.message}（前回のデータを使います）`);
          if (prev.pools && prev.pools[key]) { pools[key] = prev.pools[key]; pools[key].forEach(id => keepPrev.add(id)); }
        }
      }
    }
  }

  // -------------------------------------------------------------------
  // 2. チャンネル登録者数
  // -------------------------------------------------------------------
  const chIds = [...new Set(Object.values(raw).map(v => v.snippet.channelId))];
  const subsNow = {};
  for (let i = 0; i < chIds.length; i += 50) {
    try {
      const j = await yt('channels', { part: 'statistics', id: chIds.slice(i, i + 50).join(',') }, 1);
      for (const c of j.items || []) subsNow[c.id] = c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount;
    } catch (e) { console.warn(`FAIL channels: ${e.message}`); }
  }

  // -------------------------------------------------------------------
  // 3. 出力用の動画データ
  // -------------------------------------------------------------------
  videos = {};
  for (const id of keepPrev) if (prev.videos && prev.videos[id]) videos[id] = prev.videos[id];
  for (const [id, it] of Object.entries(raw)) {
    const st = it.statistics || {};
    const lsd = it.liveStreamingDetails;
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
      stream: !!lsd,
      live: lsd && lsd.concurrentViewers ? +lsd.concurrentViewers : null,
      lang: it.snippet.defaultAudioLanguage || it.snippet.defaultLanguage || '',
    };
  }
  for (const k of Object.keys(pools)) pools[k] = pools[k].filter(id => isJP(videos[id]));
  const used = new Set(Object.values(pools).flat());
  for (const id of Object.keys(videos)) if (!used.has(id)) delete videos[id];

  // -------------------------------------------------------------------
  // 4. 登録者推移（日本時間の日付ごと、最大14日）
  // -------------------------------------------------------------------
  histDays = Array.isArray(prev.histDays) ? prev.histDays.slice() : [];
  const prevSubs = prev.histDays ? (prev.subs || {}) : {};
  if (histDays[histDays.length - 1] !== day) histDays.push(day);
  const drop = Math.max(0, histDays.length - 14);
  histDays = histDays.slice(drop);
  subs = {};
  const usedCh = new Set(Object.values(videos).map(v => v.chId));
  for (const id of usedCh) {
    const old = (prevSubs[id] || []).slice(drop);
    const arr = histDays.map((_, i) => old[i] ?? null);
    if (subsNow[id] != null) arr[arr.length - 1] = subsNow[id];
    if (arr.some(x => x != null)) subs[id] = arr;
  }

  // -------------------------------------------------------------------
  // 5. 話題ワード（動画タイトルの【】『』#タグ）
  // -------------------------------------------------------------------
  const STOP = new Set(['vtuber', 'vtubers', '新人vtuber', '個人vtuber', 'vtuber準備中', '新人vtuber準備中', 'shorts', 'short', 'ショート',
    '切り抜き', 'ホロライブ', 'にじさんじ', 'hololive', 'nijisanji', 'ぶいすぽ', 'ぶいすぽっ!', '歌ってみた', 'cover', 'covered by', '歌枠', '雑談', '雑談配信',
    'ゲーム実況', '実況', '初見', '初見プレイ', '初見実況', 'ネタバレ注意', '縦型配信', '縦型', '配信', 'live', 'ライブ配信', '生配信', '新人',
    'おすすめ', 'fyp', 'viral', '女性実況', '男性vtuber', '女性vtuber', 'vtuber好きと繋がりたい', 'jpvtuber', 'envtuber', 'music', 'mv',
    'ゲーム', '企画', 'shorts動画', 'youtube', 'youtubeshorts', 'ytshorts', 'trending', 'funny', 'anime', 'アニメ', 'live2d', '3d', 'asmr配信', 'vsinger']);
  const tokenize = title => {
    const t = String(title || '').normalize('NFKC');
    const out = new Map();
    const add = w => {
      w = w.trim().replace(/^#+/, '').replace(/\s+/g, ' ');
      const k = w.toLowerCase();
      if (w.length < 2 || w.length > 24 || /^[\d\s.\-#]+$/.test(w) || STOP.has(k) || k.endsWith('切り抜き') || k.startsWith('vtuber')) return;
      if (!out.has(k)) out.set(k, w);
    };
    for (const m of t.matchAll(/【([^】]+)】/g)) m[1].split(/[\/|・,、]/).forEach(add);
    for (const m of t.matchAll(/『([^』]+)』/g)) add(m[1]);
    for (const m of t.matchAll(/#([^\s#]+)/g)) add(m[1]);
    return out;
  };
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  tokens = {};
  tokHist = {};
  for (const g of GENRES) {
    const ids = new Set();
    for (const f of FORMATS) for (const p of ['7', 'new']) (pools[`${g.id}|${f.id}|${p}`] || []).forEach(id => ids.add(id));
    const agg = new Map();
    for (const id of ids) {
      const v = videos[id]; if (!v) continue;
      for (const [k, w] of tokenize(v.title)) {
        const a = agg.get(k) || { ids: [], forms: {} };
        a.ids.push(id); a.forms[w] = (a.forms[w] || 0) + 1;
        agg.set(k, a);
      }
    }
    const prevH = (prev.tokHist && prev.tokHist[g.id]) || {};
    let list = [...agg.entries()].map(([k, a]) => {
      const vs = a.ids.map(id => videos[id]);
      const views = vs.reduce((s, v) => s + v.views, 0);
      const med = median(vs.map(v => v.views));
      const w = Object.entries(a.forms).sort((x, y) => y[1] - x[1])[0][0];
      const fm = { video: 0, stream: 0, short: 0 };
      vs.forEach(v => { fm[v.stream ? 'stream' : (v.dur > 0 && v.dur <= 180 ? 'short' : 'video')]++; });
      return { k, w, n: a.ids.length, views, med, fm, score: a.ids.length * Math.log10(10 + med),
        top: a.ids.slice().sort((x, y) => videos[y].views - videos[x].views).slice(0, 12) };
    });
    list.sort((a, b) => (b.n >= 2) - (a.n >= 2) || b.score - a.score);
    list = list.slice(0, 60);
    const hist = {};
    for (const t of list) {
      const h = (prevH[t.k] || []).slice(-13);
      const avg = h.length ? h.reduce((s, x) => s + x, 0) / h.length : 0;
      t.st = !h.length ? 'new' : t.n >= avg * 1.5 ? 'up' : t.n <= avg * 0.6 ? 'down' : 'steady';
      t.prev = h.length ? Math.round(avg * 10) / 10 : null;
      hist[t.k] = [...h, t.n];
      delete t.score;
    }
    tokens[g.id] = list;
    tokHist[g.id] = hist;
  }

}
{ // ここから下（検索ワード・新作ゲーム）は AI_ONLY のときも実行（YouTubeの枠を使わないため）
  // -------------------------------------------------------------------
  // 6. 検索ワード：YouTube検索候補 / Googleトレンド（日本）
  // -------------------------------------------------------------------
  const suggest = async q => {
    const u = 'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ja&gl=jp&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = new TextDecoder('utf-8').decode(await r.arrayBuffer());
    const j = JSON.parse(text);
    return Array.isArray(j[1]) ? j[1] : [];
  };
  suggestOut = {};
  const SEEDS = ['', ' ', ' あ', ' い', ' う', ' お', ' か', ' き', ' こ', ' さ', ' し', ' た', ' な', ' は', ' ま', ' や', ' ら', ' わ', ' a', ' e', ' r', ' s'];
  for (const g of GENRES) {
    const bases = g.id === 'all' ? ['vtuber'] : ['vtuber ' + g.sk, g.sk + ' vtuber'];
    const score = new Map();
    try {
      for (const base of bases) {
        for (const [si, s] of SEEDS.entries()) {
          const list = await suggest(base + s);
          list.forEach((w, i) => {
            const k = w.trim().toLowerCase();
            if (!k || k === base.toLowerCase()) return;
            score.set(k, (score.get(k) || 0) + (10 - i) * (si <= 1 ? 3 : 1));
          });
          await sleep(200);
        }
      }
      // 50件に届かないときは、出てきた候補をさらに検索して広げる
      for (const w of [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(x => x[0])) {
        if (score.size >= 70) break;
        (await suggest(w + ' ')).forEach((x, i) => {
          const k = x.trim().toLowerCase();
          if (k && k !== w) score.set(k, (score.get(k) || 0) + (10 - i) * 0.5);
        });
        await sleep(200);
      }
      suggestOut[g.id] = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([w, s]) => ({ w, s }));
      console.log(`OK   suggest ${g.id}: ${suggestOut[g.id].length}件`);
    } catch (e) {
      console.warn(`FAIL suggest ${g.id}: ${e.message}`);
      suggestOut[g.id] = (prev.suggest && prev.suggest[g.id]) || [];
    }
  }
  gtrends = [];
  try {
    const xml = await (await fetch('https://trends.google.co.jp/trending/rss?geo=JP', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const w = dec((/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1] || '');
      const tr = dec((/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(m[1]) || [])[1] || '');
      const news = dec((/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/.exec(m[1]) || [])[1] || '');
      if (w) gtrends.push({ w, traffic: tr, news, d: day });
    }
    // RSSは1回10〜20件なので、過去の急上昇ワードも貯めて最大50件にする（新しい日付が上）
    const todayW = new Set(gtrends.map(t => t.w));
    gtrends = [...gtrends, ...(prev.gtrends || []).filter(t => !todayW.has(t.w)).map(t => ({ ...t, d: t.d || '' }))].slice(0, 50);
    console.log(`OK   google trends: ${gtrends.length}件（今日 ${todayW.size}件）`);
  } catch (e) {
    console.warn(`FAIL google trends: ${e.message}`);
    gtrends = prev.gtrends || [];
  }

  // -------------------------------------------------------------------
  // 6.5 新作ゲーム（Steam：キー不要）発売予定 / 最近発売 × ジャンル 各50件
  // -------------------------------------------------------------------
  const STEAM_G = [
    { id: 'all', tag: null }, { id: 'horror', tag: 1667 }, { id: 'action', tag: 19 }, { id: 'adventure', tag: 21 },
    { id: 'rpg', tag: 122 }, { id: 'coop', tag: 1685 }, { id: 'sim', tag: 599 },
  ];
  const SH = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja' };
  const oldApps = (prev.steam && prev.steam.apps) || {};
  steam = { soon: {}, new: {}, apps: {} };
  let fetched = 0;
  async function appInfo(id) {
    const o = oldApps[id];
    if (o && (o.err || Date.now() - Date.parse(o.got) < 5 * 864e5)) return o; // 5日間は再利用
    if (fetched >= 300) return o || null; // 1回の実行で取りに行く上限
    fetched++;
    await sleep(1500);
    const j = await (await fetch(`https://store.steampowered.com/api/appdetails?appids=${id}&cc=jp&l=japanese`, { headers: SH })).json();
    const d = j && j[id] && j[id].success ? j[id].data : null;
    if (!d) return { err: 1, got: new Date().toISOString() };
    const adult = (d.required_age && +d.required_age >= 18) || ((d.content_descriptors && d.content_descriptors.ids) || []).some(x => x === 3 || x === 4);
    return {
      id, name: d.name, img: d.header_image, desc: d.short_description || '',
      date: (d.release_date && d.release_date.date) || '', soon: !!(d.release_date && d.release_date.coming_soon),
      genres: (d.genres || []).map(x => x.description), pf: d.platforms || {},
      price: d.is_free ? '無料' : (d.price_overview && d.price_overview.final_formatted) || '',
      dev: (d.developers || []).join(', '), adult: adult ? 1 : 0, got: new Date().toISOString(),
    };
  }
  try {
    for (const [mode, filter] of [['soon', 'popularcomingsoon'], ['new', 'popularnew']]) {
      for (const g of STEAM_G) {
        const u = `https://store.steampowered.com/search/results/?query&start=0&count=60&filter=${filter}&infinite=1&cc=JP&l=japanese&ignore_preferences=1${g.tag ? '&tags=' + g.tag : ''}`;
        const j = await (await fetch(u, { headers: SH })).json();
        const ids = [...new Set([...(j.results_html || '').matchAll(/data-ds-appid="(\d+)/g)].map(m => m[1]))];
        const list = [];
        for (const id of ids) {
          if (list.length >= 50) break;
          const a = await appInfo(id);
          if (!a || a.err || a.adult) { if (a) steam.apps[id] = a; continue; }
          steam.apps[id] = a; list.push(id);
        }
        steam[mode][g.id] = list;
        console.log(`OK   steam ${mode} ${g.id}: ${list.length}件`);
      }
    }
  } catch (e) {
    console.warn(`FAIL steam: ${e.message}（前回のデータを使います）`);
    if (prev.steam) steam = prev.steam;
  }

  // -------------------------------------------------------------------
  // 6.6 歴代名作の「YouTubeでよく見られている度」（1日15作品ずつ計測）
  //     「ゲーム名 実況」の再生数上位50本の合計再生数（AI_ONLY のときはスキップ）
  // -------------------------------------------------------------------
  if (!AI_ONLY) try {
    const list = JSON.parse(await readFile(new URL('../classics.json', import.meta.url), 'utf8'));
    const order = list.slice().sort((a, b) => (classic[a.id] ? Date.parse(classic[a.id].d) : 0) - (classic[b.id] ? Date.parse(classic[b.id].d) : 0));
    for (const c of order.slice(0, 15)) {
      try {
        const s = await yt('search', { part: 'snippet', type: 'video', q: c.q, maxResults: 50, order: 'viewCount', regionCode: 'JP', relevanceLanguage: 'ja' }, 100);
        const ids = (s.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
        const vj = ids.length ? await yt('videos', { part: 'snippet,statistics', id: ids.join(',') }, 1) : { items: [] };
        const vs = (vj.items || []).map(v => ({ id: v.id, title: v.snippet.title, ch: v.snippet.channelTitle, views: +(v.statistics.viewCount || 0) }))
          .filter(v => JA.test(v.title)).sort((a, b) => b.views - a.views);
        classic[c.id] = { views: vs.reduce((t, v) => t + v.views, 0), n: vs.length, top: vs.slice(0, 5), d: new Date().toISOString() };
        console.log(`OK   classic ${c.id}: ${classic[c.id].views}`);
      } catch (e) { console.warn(`FAIL classic ${c.id}: ${e.message}`); }
    }
  } catch (e) { console.warn(`FAIL classics.json: ${e.message}`); }
}

// ---------------------------------------------------------------------
// 7. Gemini（任意）：伸びた理由・流行の経緯・解説動画の要約
// ---------------------------------------------------------------------
let mi = 0;
async function gemini(parts) {
  for (;;) {
    const model = MODELS[mi];
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEM}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } }),
    });
    const j = await r.json();
    if (j.error) {
      if (mi < MODELS.length - 1 && /no longer available|not found|not supported|is not available/i.test(j.error.message)) {
        console.warn(`model ${model} は使えないため ${MODELS[mi + 1]} を試します`);
        mi++; continue;
      }
      throw new Error(`${model}: ${j.error.message}`);
    }
    let text = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    return JSON.parse(text);
  }
}
const aiBuzz = {};
const aiTok = {};
let out_kb = Array.isArray(prev.kb) ? prev.kb : [];
const know = { ...(prev.know || {}) };
const ratioOf = v => v.subs ? v.views / v.subs : 0;
if (GEM) {
  // 7-1. バズ動画の理由（ジャンルごと上位10本、過去に書いたものは再利用）
  const oldBuzz = prev.aiBuzz || {};
  for (const g of GENRES) {
    const ids = new Set();
    for (const f of FORMATS) for (const p of ['7', 'new']) (pools[`${g.id}|${f.id}|${p}`] || []).forEach(id => ids.add(id));
    const top = [...ids].map(id => videos[id]).filter(v => v && v.subs && v.views >= 10000 && !isClip(v)).sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, 10);
    const todo = top.filter(v => !oldBuzz[v.id]);
    top.forEach(v => { if (oldBuzz[v.id]) aiBuzz[v.id] = oldBuzz[v.id]; });
    if (!todo.length) continue;
    const lines = todo.map(v => `${v.id} | ${v.title} | ${v.ch} | 登録者${v.subs} | 再生${v.views} | 公開から${Math.max(1, Math.round((now - Date.parse(v.published)) / 864e5))}日 | 高評価${v.likes} | コメント${v.comments} | ${v.stream ? '配信アーカイブ' : v.dur <= 180 ? 'ショート' : '動画'}`).join('\n');
    try {
      const res = await gemini([{ text:
        'あなたはVTuber・YouTubeのアナリストです。次の動画それぞれについて、タイトル・数字から考えられる「伸びた理由と経緯」を日本語で2〜3文で書いてください。' +
        '事実として分からないことは「〜と考えられる」と推測であることを明記し、誇張しないでください。' +
        '出力はJSON配列 [{"id":"動画ID","reason":"理由"}] のみ。\n\n' + lines }]);
      for (const x of res || []) if (x && x.id && x.reason) aiBuzz[x.id] = x.reason;
      console.log(`OK   gemini buzz ${g.id}: ${todo.length}本`);
    } catch (e) { console.warn(`FAIL gemini buzz ${g.id}: ${e.message}`); }
    await sleep(7000);
  }
  // 7-2. 話題ワードの流行理由（ジャンルごと上位20語）
  for (const g of GENRES) {
    const list = (tokens[g.id] || []).slice(0, 20);
    if (!list.length) continue;
    const lines = list.map(t => `「${t.w}」(${t.n}本): ` + t.top.slice(0, 4).map(id => videos[id] && videos[id].title).filter(Boolean).join(' / ')).join('\n');
    try {
      const res = await gemini([{ text:
        'あなたはVTuber・YouTubeのアナリストです。次はここ1週間のVTuber動画タイトルによく出てくるワードと、その代表的な動画タイトルです。' +
        '各ワードについて「何なのか」と「なぜ今流行っているのか（経緯）」を日本語で2文で説明してください。分からない点は推測と明記してください。' +
        '出力はJSON配列 [{"w":"ワード","reason":"説明"}] のみ。ワードは入力と完全に同じ表記にしてください。\n\n' + lines }]);
      aiTok[g.id] = {};
      for (const x of res || []) if (x && x.w && x.reason) aiTok[g.id][x.w] = x.reason;
      console.log(`OK   gemini tokens ${g.id}: ${Object.keys(aiTok[g.id]).length}語`);
    } catch (e) {
      console.warn(`FAIL gemini tokens ${g.id}: ${e.message}`);
      if (prev.aiTok && prev.aiTok[g.id]) aiTok[g.id] = prev.aiTok[g.id];
    }
    await sleep(7000);
  }
  // 7-3. 解説動画の要約：1日2本ずつ蓄積
  //      まだ要約がない解説記事（KNOW_SRC）を先に埋め、その後はテーマを日替わりで回して「要約ライブラリ」に追加
  const SUMMARY_PROMPT = 'この動画の内容を日本語で要約してください。出力はJSONのみ: ' +
    '{"summary":["3行要約の1行目","2行目","3行目"],"points":[{"h":"見出し","p":"説明（2〜3文）"}],"forVtuber":["VTuber・配信者がすぐ実践できること"]}。' +
    'points は4〜6個、forVtuber は2〜3個。動画で実際に話されている内容だけを書いてください。';
  const KB_TOPICS = [
    { cat: 'algo',   q: ['YouTube algorithm explained', 'YouTube アルゴリズム 解説', 'how YouTube recommends videos'] },
    { cat: 'thumb',  q: ['YouTube thumbnail tips', 'YouTube タイトル サムネ 伸ばし方', 'YouTube packaging title thumbnail'] },
    { cat: 'short',  q: ['YouTube Shorts strategy', 'YouTubeショート 伸ばし方', 'YouTube Shorts retention tips'] },
    { cat: 'mental', q: ['YouTuber burnout advice', 'creator mental health YouTube', 'YouTube 続ける コツ'] },
    { cat: 'live',   q: ['how to grow a VTuber channel', 'VTuber 配信 伸ばし方', 'YouTube live stream growth tips', '個人VTuber 伸ばし方'] },
  ];
  let kb = Array.isArray(prev.kb) ? prev.kb.slice() : [];
  const usedVid = new Set([...kb.map(x => x.id), ...Object.values(know).map(x => x.id)]);
  const dayNo = Math.floor(now / 864e5);
  let slots = 2;
  const summarize = async (vid) => gemini([{ file_data: { file_uri: `https://www.youtube.com/watch?v=${vid}` } }, { text: SUMMARY_PROMPT }]);
  const pickVideo = async (q) => {
    const s = await yt('search', { part: 'snippet', type: 'video', q, maxResults: 10, videoDuration: 'medium', order: 'relevance', publishedAfter: after(730) }, 100);
    return (s.items || []).find(it => it.id && it.id.videoId && !usedVid.has(it.id.videoId));
  };
  // (a) 解説記事の元動画
  for (const k of Object.keys(KNOW_SRC).filter(k => !know[k])) {
    if (slots <= 0) break;
    slots--;
    try {
      const it = await pickVideo(KNOW_SRC[k]);
      if (!it) continue;
      const vid = it.id.videoId; usedVid.add(vid);
      const res = await summarize(vid);
      know[k] = { id: vid, title: it.snippet.title, ch: it.snippet.channelTitle, ...res, made: day };
      console.log(`OK   gemini know ${k}: ${vid}`);
    } catch (e) { console.warn(`FAIL gemini know ${k}: ${e.message}`); }
    await sleep(7000);
  }
  // (b) 要約ライブラリ（テーマ日替わり）
  for (let i = 0; slots > 0 && i < 4; i++) {
    const topic = KB_TOPICS[(dayNo * 2 + i) % KB_TOPICS.length];
    const q = topic.q[(dayNo + i) % topic.q.length];
    slots--;
    try {
      const it = await pickVideo(q);
      if (!it) continue;
      const vid = it.id.videoId; usedVid.add(vid);
      const res = await summarize(vid);
      kb.unshift({ id: vid, title: it.snippet.title, ch: it.snippet.channelTitle, cat: topic.cat, q, ...res, made: day });
      console.log(`OK   gemini kb ${topic.cat}: ${vid}`);
    } catch (e) { console.warn(`FAIL gemini kb ${topic.cat}: ${e.message}`); }
    await sleep(7000);
  }
  kb = kb.slice(0, 500);
  out_kb = kb;
} else {
  console.log('GEMINI_API_KEY なし：AIによる理由・要約はスキップ（画面ではルールベースの理由を表示）');
}

// ---------------------------------------------------------------------
const out = {
  updated: AI_ONLY ? prev.updated : new Date(now).toISOString(), units, ai: !!GEM,
  pools, videos, histDays, subs, tokens, tokHist,
  suggest: suggestOut, gtrends, aiBuzz, aiTok, know, kb: out_kb, steam, classic,
};
await writeFile(OUT, JSON.stringify(out));
console.log(`完了: 動画${Object.keys(videos).length}本 / 使用ユニット 約${units}${GEM ? ` / AIモデル ${MODELS[mi]}` : ''}`);
