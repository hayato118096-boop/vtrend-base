// =====================================================================
// VTrend Base データ更新スクリプト（GitHub Actions が毎日17時過ぎ・日本時間に実行。YouTube APIの無料枠が戻った後）
//
// ・YouTube Data API v3（無料枠 1日10,000ユニット）で「ジャンル × 形式（動画・配信・ショート）」ごとに動画を集める
//     期間は 7日（2ページ）/ 28日 / 新着。切り抜きは3日かけて貯める。歴代名作は1日8作品ずつ計測。合計 約8,500ユニット
//     ※ 無料枠は太平洋時間0時（日本時間16〜17時）にリセット。同じ枠内で通常の手動実行を重ねないこと
// ・VTuberの活動と関係ない動画（海外・反応集・ニュース・健康系など）は除外
// ・話題ワード（ジャンル×形式×7日/28日）、YouTube検索候補（ジャンル×形式）、Googleトレンド（日本）
// ・流行アーカイブ：毎日の話題ワードを貯めて、2026年以降の流行として残す
// ・新作ゲームは Steam ストアから取得（キー不要）
// ・GEMINI_API_KEY があれば、Gemini（無料枠）で「伸びた理由」「流行の経緯」「ノウハウ記事（動画＋Web記事から作成・更新）」を作る
// ・AI_ONLY=true のときは YouTube のデータ取得をせず、前回のデータで AI の部分だけ作り直す
// ・CH_ONLY=true のときは動画のデータは前回のまま、チャンネルの情報（登録者・アイコン・総再生・注目動画）だけ更新する
// =====================================================================
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.YT_API_KEY;
if (!KEY) { console.error('環境変数 YT_API_KEY が設定されていません'); process.exit(1); }
const GEM = process.env.GEMINI_API_KEY || '';
const OUT = new URL('../data.json', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ジャンル（index.html の GENRES と同じ順番・id）
const GENRES = [
  { id: 'all',    kw: '',           sk: '' },
  { id: 'game',   kw: 'ゲーム実況', sk: 'ゲーム' },
  { id: 'song',   kw: '歌ってみた', sk: '歌ってみた' },
  { id: 'talk',   kw: '雑談',       sk: '雑談' },
  { id: 'plan',   kw: '企画',       sk: '企画' },
  { id: 'horror', kw: 'ホラーゲーム', sk: 'ホラゲ' },
];
const FORMATS = [
  { id: 'video',  extra: { videoDuration: 'medium' }, sfx: '' },        // 4〜20分の投稿動画
  { id: 'stream', extra: { eventType: 'completed' },  sfx: ' 配信' },   // 配信アーカイブ
  { id: 'short',  extra: { videoDuration: 'short' },  sfx: ' shorts' }, // 3分以内をショート扱い
];
const VPARTS = 'snippet,statistics,contentDetails,liveStreamingDetails';
// 配信かどうか：プレミア公開（歌ってみた・MVなど）にも liveStreamingDetails が付くので、公開済みで10分未満のものは配信にしない
const isLive = (it, dur) => !!(it && it.liveStreamingDetails) && !(it.snippet && it.snippet.liveBroadcastContent === 'none' && dur > 0 && dur < 600);
const isoDur = s => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '') || []; return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0); };
const now = Date.now();
const day = new Date(now + 9 * 3600e3).toISOString().slice(0, 10); // 日本時間の日付
const dayNo = Math.floor((now + 9 * 3600e3) / 864e5);
const after = d => new Date(now - d * 864e5).toISOString();
const diag = { errors: [], model: null, models: [] };
let MODEL = null;
// 使うモデルの候補（上から順に使い、混雑・無料枠切れのときは次のモデルに切り替える。無料枠はモデルごとに別）
// ※ 最初のAIの動画チェック（A-3.5）から使うので、ファイルの先頭で用意しておく
let MODELS = [];
const deadModels = new Set();
const AI_DEADLINE = 33 * 60e3; // 開始から33分を過ぎたらAIの処理はしない
// モデルの使い分け（運営の指定・無料で呼べる回数）
//   高性能（重要で判断がややこしい仕事）：3.8 Flash 5回 → 3.6 Flash 5回
//   軽量（量が多い・単純な仕事）        ：3.5 Flash Lite 15回 → 3.1 Flash Lite 15回
//   それぞれ使い切ったら、同じグループの次のモデル → 最後にもう一方のグループへ
const LIMITS = { 'gemini-3.8-flash': 5, 'gemini-3.6-flash': 5, 'gemini-3.5-flash-lite': 15, 'gemini-3.1-flash-lite': 15 };
const TIER = { high: ['gemini-3.8-flash', 'gemini-3.6-flash'], lite: ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] };
const usedCalls = {}, lastCall = {};
const parseJSON = text => {
  text = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(text); } catch {}
  const m = /[\[{][\s\S]*[\]}]/.exec(text);
  return m ? JSON.parse(m[0]) : null;
};
// AIによる動画の精査：VTuber本人の活動か（1）、関係ない動画か（0）。一度判定した動画は覚えておく
let aiv = {};
async function screenVideos(ids, videosMap) {
  if (!GEM) return;
  if (!MODEL) { MODEL = await pickModel(); diag.model = MODEL; }
  const todo = ids.filter(id => aiv[id] === undefined && videosMap[id]).slice(0, 480); // 1日480本まで（無料枠の回数を、AI分析・記事づくりの分も残すため。判定済みは覚えておくので毎日少しずつ増える）
  let done = 0;
  // 160本ずつまとめて判定（呼び出し回数を減らすため）
  for (let i = 0; i < todo.length; i += 160) {
    const batch = todo.slice(i, i + 160);
    const lines = batch.map(id => `${id} | ${videosMap[id].title} | ${videosMap[id].ch}`).join('\n');
    try {
      const { data } = await gemini([{ text:
        'あなたはVTuberのトレンドを調べる編集者です。次の動画が「VTuber（または配信者）本人が自分で配信・投稿した活動コンテンツ」かを判定してください。\n' +
        'k=1（残す）：ゲーム実況・配信アーカイブ・歌ってみた・歌枠・雑談・企画・コラボ・ショートなど、本人の活動で、他のVTuberが企画の参考にできるもの。\n' +
        'k=0（外す）：他人が作った反応集・まとめ・ニュース・ゴシップ・考察・解説（VTuberについて語るもの）、切り抜きチャンネル、ファンアート・ファンアニメ、広告・講座・宣伝、VTuberと関係ない一般の動画、日本語以外の動画。\n' +
        '迷う場合は k=1 にしてください。出力はJSON配列 [{"id":"動画ID","k":1}] のみ。\n\n' + lines }]);
      for (const x of data || []) if (x && x.id && (x.k === 0 || x.k === 1)) { aiv[x.id] = x.k; done++; }
    } catch (e) { logErr('gemini screen', e); if (/使えるAIモデル|quota|exhausted|再試行の上限|時間切れ/i.test(String(e.message))) break; }
    await sleep(4500);
  }
  console.log(`OK   AI精査: ${done}本を判定（外す ${Object.values(aiv).filter(x => x === 0).length}本）`);
}
// 最終判定：AIの判定があればそれを優先、なければルールのフィルター
const keepVideo = (v, g) => v && (aiv[v.id] === 1 ? (isJP(v) && !HANGUL.test(v.title || '')) : aiv[v.id] === 0 ? false : isRelevant(v)) && genreOk(g, v);
const logErr = (where, e) => { const m = String(e && e.message || e).replace(GEM || '###', '***').replace(KEY, '***').slice(0, 300); console.warn(`FAIL ${where}: ${m}`); if (diag.errors.length < 30) diag.errors.push(`${where}: ${m}`); };

// ---------------------------------------------------------------------
// フィルター（index.html にも同じものがある）
// ---------------------------------------------------------------------
const KANA = /[぀-ヿ]/;
const isJP = v => !!v && (KANA.test(v.title || '') || (/^ja/i.test(v.lang || '') && /[一-鿿]/.test(v.title || '')));
const isClip = v => /切り抜き|切抜き|きりぬき|clip|クリップ|全く度しが/i.test((v.title || '') + ' ' + (v.ch || ''));
// VTuberについて語る動画・関係ない動画（反応集・ニュース・講座・翻訳・健康系など）
const META_BAD = /反応集|みんなの反応|に対する(みんな|ネット)|まとめ動画|考察|ニュース|語った|真意|VTuber(業界|市場)|業界|炎上|引退理由|元刑事|専門家|が解説|を解説する|解説してみた|ツボ|セルフケア|ストレッチ|ダイエット|占い|副業|投資|株価|仮想通貨|英会話|アンチ|賠償|特定され|訴訟|裁判|逮捕|暴露|謝罪|ゆっくり解説|2ch|5ch|面白いスレ|翻訳|翻譯|中文|精華|精华|中字|伸ばす方法|やるべきこと|講座|オーディション|魂募集|採用担当|入門|作業用BGM|ZIP!|インタビュー|VTuberはなぜ|(女性|男性)?VTuberの(リアル|顔|身長|下着|コスプレ|モテ|同棲|事情)|VTuberに(投稿頻度|聞いたら)/i;
// 解説・ニュース・翻訳・まとめ系のチャンネル
const CH_BAD = /解説|分析|ニュース|速報|まとめ|翻訳|ゆっくり|2ch|5ch|日テレ|テレビ|構造|の先生|せんせー|情報局|推し隊|つどいch|k1rq/i;
const HANGUL = /[가-힯]|[這們麼嗎妳裡們说们这么吗视频戏]|台V|台灣|中文/;
// VTuberを題材にした寸劇（#マイクラ より前の本文に「VTuber」が入っているもの）
const SKIT = { test: t => { t = String(t || '').normalize('NFKC'); if (!/#マイクラ|#minecraft/i.test(t)) return false; return /vtuber/i.test(t.split('#')[0]); } };
// ファンアート・依頼・AI生成・講座など、VTuber本人の活動ではないもの
const NOT_ACT = /fanmade|fan made|ファンアート|描かせて|描きます|有償依頼|依頼|発掘企画|ai生成|ai vtuber|aivtuber|裏の事情|vtuberは誰|howto|how to|初心者でもできる|mix講座/i;
// VTuberの活動らしさ（配信・実況・歌・企画など）
const ACT = /配信|実況|プレイ|初見|耐久|参加型|コラボ|凸待ち|企画|歌枠|歌ってみた|cover|カバー|オリジナル曲|MV|雑談|朝活|作業|ASMR|お披露目|初配信|ホラー|ゲーム|ガチャ|ランクマ|RTA|縛り|検証|やってみた|チャレンジ|大会|踊ってみた|LIVE|ライブ|切り抜き|#shorts/i;
const isRelevant = v => isJP(v) && !HANGUL.test(v.title || '') && !SKIT.test(v.title) && !NOT_ACT.test(String(v.title || '').normalize('NFKC')) && !META_BAD.test(v.title || '') && !CH_BAD.test(v.ch || '') && (ACT.test(v.title || '') || /【[^】]+】|《[^》]+》/.test(v.title || ''));

// ジャンルらしさ（歌・雑談・企画・ホラーは中身がずれやすいので、タイトルで確認）
const GENRE_RE = { song:/歌|cover|カバー|歌枠|MV|オリジナル曲|karaoke|singing/i, talk:/雑談|朝活|作業|マシュマロ|お悩み|相談|晩酌|おしゃべり|フリートーク|夜活/, plan:/企画|凸待ち|検証|やってみた|チャレンジ|耐久|参加型|大会|お披露目|記念|罰ゲーム|対決/, horror:/ホラー|ホラゲ|怖|恐怖|異変|絶叫|心霊|8番出口|R\.?E\.?P\.?O|リトルナイトメア|夜勤事件|banban|デッドバイデイライト|dbd|phasmophobia|青鬼|サイレントヒル|バイオ|outlast|lethal/i };
const genreOk = (g, v) => !GENRE_RE[g] || GENRE_RE[g].test(v.title || '');
// 企画スタイル（参加型・コラボなど）
const STYLES = [
  ['参加型', /参加型|視聴者参加|リスナー参加|参加OK/], ['コラボ', /コラボ|collab|ゲスト|w\/|×/i], ['耐久', /耐久|終われない|まで(寝|やめ|終わ)/],
  ['初見', /初見/], ['縛り・チャレンジ', /縛り|チャレンジ|RTA|ノーダメ|検証/], ['大会・対戦', /大会|カップ|トーナメント|対決|\bvs\b/i],
  ['歌枠', /歌枠|カラオケ/], ['雑談・マシュマロ', /雑談|マシュマロ|お悩み|相談/], ['ASMR', /ASMR|囁き/], ['同時視聴', /同時視聴|ミラー/],
  ['凸待ち', /凸待ち/], ['ガチャ・開封', /ガチャ|開封/], ['実況プレイ', /実況|プレイ|攻略/],
];
const styleOf = title => STYLES.filter(([, re]) => re.test(title || '')).map(([n]) => n);

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
// 形式：配信 / ショート / 動画。sh（youtube.com/shorts で確認した結果）があればそれを優先、なければ3分以内をショート扱い
const fmtOf = v => v.stream ? 'stream' : v.sh === true ? 'short' : v.sh === false ? 'video' : (v.dur > 0 && v.dur <= 180 ? 'short' : 'video');

// チャンネルの登録者数・総再生数・アイコン（50件で1ユニット）
const chStat = {};
async function fetchChannels(ids, subsNow) {
  ids = ids.filter(id => !chStat[id]);
  for (let i = 0; i < ids.length; i += 50) {
    try {
      const j = await yt('channels', { part: 'snippet,statistics', id: ids.slice(i, i + 50).join(',') }, 1);
      for (const c of j.items || []) {
        const st = c.statistics || {}, th = c.snippet && c.snippet.thumbnails;
        chStat[c.id] = { subs: st.hiddenSubscriberCount ? null : +st.subscriberCount, views: +(st.viewCount || 0), vc: +(st.videoCount || 0),
          th: th ? (th.default || th.medium || {}).url || '' : '', n: c.snippet ? c.snippet.title : '' };
      }
    } catch (e) { logErr('channels', e); }
  }
  for (const id of Object.keys(chStat)) subsNow[id] = chStat[id].subs;
}

// ショート判定：1〜3分の動画は youtube.com/shorts/ID を確認（ショートならそのまま200、普通の動画は watch へリダイレクト）
// 3分以内の歌ってみた・MVなどが「ショート」に混ざらないようにする（YouTube APIの無料枠は使わない）
let shFail = 0;
async function checkShorts(list, max) {
  const todo = list.filter(v => !v.stream && v.dur > 60 && v.dur <= 180 && v.sh == null).slice(0, max);
  let done = 0;
  for (let i = 0; i < todo.length && shFail < 30; i += 8) {
    await Promise.all(todo.slice(i, i + 8).map(async v => {
      try {
        const r = await fetch('https://www.youtube.com/shorts/' + v.id, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
        const loc = r.headers.get('location') || '';
        if (r.status === 200) { v.sh = true; done++; }
        else if (r.status >= 300 && r.status < 400 && /\/watch/.test(loc)) { v.sh = false; done++; }
        else shFail++;
      } catch { shFail++; }
    }));
  }
  console.log(`OK   ショート判定: ${done}本を確認（失敗の合計 ${shFail}）`);
  if (shFail >= 30) logErr('shorts check', new Error(`確認に${shFail}回失敗したため途中で止めました`));
}

let prev = {};
try { prev = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* 初回 */ }
// 旧データ（30日）を28日に読み替え
if (prev.pools) for (const k of Object.keys(prev.pools)) if (k.endsWith('|30')) prev.pools[k.replace(/\|30$/, '|28')] = prev.pools[k];
// CH_ONLY：動画のデータは前回のまま、チャンネル（登録者・アイコン・総再生・注目動画）だけ更新し、ナレッジ記事を3本追加する（合計 約2,100ユニット）
const CH_ONLY = process.env.CH_ONLY === 'true' && !!prev.pools;
const AI_ONLY = (process.env.AI_ONLY === 'true' || CH_ONLY) && !!prev.pools;
if (CH_ONLY) console.log('CH_ONLY モード：動画のデータは前回のものを使い、チャンネルの情報だけ更新します');
else if (AI_ONLY) console.log('AI_ONLY モード：YouTube のデータは前回のものを使い、AI の部分だけ作り直します');

let pools, videos, histDays, subs, tokens, tokens2, tokHist, suggestOut, gtrends, archive, chans, chv, chtop;
let steam = prev.steam || null, classic = prev.classic || {};

// =====================================================================
// A. YouTube のデータ（AI_ONLY のときは前回のものを使う）
// =====================================================================
if (AI_ONLY) {
  ({ pools, videos, histDays, subs, tokens, tokHist, gtrends } = prev);
  tokens2 = prev.tokens2 || {};
  chans = prev.chans || {}; chv = prev.chv || {}; chtop = prev.chtop || {};
  archive = prev.archive || {};
  suggestOut = prev.suggest || {};
  aiv = { ...(prev.aiv || {}) };
  if (!CH_ONLY) await screenVideos([...new Set(Object.entries(pools).filter(([k]) => !k.startsWith('clip|')).flatMap(([, ids]) => ids))], videos);
  for (const k of Object.keys(pools)) pools[k] = pools[k].filter(id => videos[id] && (k.startsWith('clip|') ? isJP(videos[id]) : keepVideo(videos[id], k.split('|')[0])));
  if (CH_ONLY) {
    const subsNow = {};
    await fetchChannels([...new Set(Object.values(videos).map(v => v.chId))], subsNow);
    await channelSteps(subsNow);
  }
} else {
  // -------------------------------------------------------------------
  // 1. 動画プール：ジャンル × 形式 × (7日[2ページ] / 28日[1ページ] / 新着[1ページ])
  // -------------------------------------------------------------------
  pools = {};
  const keepPrev = new Set();
  for (const g of GENRES) {
    for (const f of FORMATS) {
      const base = {
        part: 'snippet', type: 'video', regionCode: 'JP', relevanceLanguage: 'ja', maxResults: 50,
        q: ['VTuber', g.kw].filter(Boolean).join(' '), ...f.extra,
      };
      const jobs = [
        ['7',   { ...base, order: 'viewCount', publishedAfter: after(7) },  2],
        ['28',  { ...base, order: 'viewCount', publishedAfter: after(28) }, 1],
        ['new', { ...base, order: 'date',      publishedAfter: after(7) },  1], // 小規模チャンネル発掘用
      ];
      for (const [p, params, pages] of jobs) {
        const key = `${g.id}|${f.id}|${p}`;
        try {
          const ids = await search(params, pages);
          await fetchVideos(ids);
          // 形式の振り分けは、ショート判定のあと（3.2）でまとめて行う
          pools[key] = ids.filter(id => raw[id]);
          console.log(`OK   ${key}: ${pools[key].length}件`);
        } catch (e) {
          logErr(key, e);
          if (prev.pools && prev.pools[key]) { pools[key] = prev.pools[key]; pools[key].forEach(id => keepPrev.add(id)); }
        }
      }
    }
  }
  // 切り抜き：4つの検索を3日かけてローテーション（前回分と合わせて貯める）
  const CLIP_JOBS = [['video', '7'], ['short', '7'], ['video', '28'], ['short', '28']];
  const todayClip = [CLIP_JOBS[(dayNo * 2) % 4], CLIP_JOBS[(dayNo * 2 + 1) % 4]];
  for (const [fid, p] of CLIP_JOBS) {
    const key = `clip|${fid}|${p}`;
    const old = ((prev.pools && prev.pools[key]) || []).filter(id => prev.videos && prev.videos[id] && Date.parse(prev.videos[id].published) > now - (+p) * 864e5);
    old.forEach(id => keepPrev.add(id));
    let fresh = [];
    if (todayClip.some(([a, b]) => a === fid && b === p)) {
      try {
        const f = FORMATS.find(x => x.id === fid);
        const ids = await search({ part: 'snippet', type: 'video', regionCode: 'JP', relevanceLanguage: 'ja', maxResults: 50, q: 'VTuber 切り抜き', ...f.extra, order: 'viewCount', publishedAfter: after(+p) }, 1);
        await fetchVideos(ids);
        fresh = ids.filter(id => raw[id]);
        console.log(`OK   ${key}: 新しく${fresh.length}件`);
      } catch (e) { logErr(key, e); }
    }
    pools[key] = [...new Set([...fresh, ...old])].slice(0, 150);
  }

  // -------------------------------------------------------------------
  // 2. チャンネル登録者数
  // -------------------------------------------------------------------
  const chIds = [...new Set(Object.values(raw).map(v => v.snippet.channelId))];
  const subsNow = {};
  await fetchChannels(chIds, subsNow);

  // -------------------------------------------------------------------
  // 3. 出力用の動画データ ＋ フィルター
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
      subs: subsNow[it.snippet.channelId] ?? (prev.videos && prev.videos[id] ? prev.videos[id].subs : null),
      views: +(st.viewCount || 0),
      likes: +(st.likeCount || 0),
      comments: +(st.commentCount || 0),
      published: it.snippet.publishedAt,
      dur: isoDur(it.contentDetails && it.contentDetails.duration),
      stream: isLive(it, isoDur(it.contentDetails && it.contentDetails.duration)),
      live: lsd && lsd.concurrentViewers ? +lsd.concurrentViewers : null,
      lang: it.snippet.defaultAudioLanguage || it.snippet.defaultLanguage || '',
    };
  }
  // 3.2 ショート判定：1〜3分の動画は youtube.com/shorts/ID を確認（ショートならそのまま200、普通の動画は watch へリダイレクト）
  //     3分以内の歌ってみた・MVなどが「ショート」に混ざらないようにする。一度調べた動画は覚えておく
  for (const v of Object.values(videos)) { const p = prev.videos && prev.videos[v.id]; if (v.sh == null && p && p.sh != null) v.sh = p.sh; }
  await checkShorts(Object.values(videos), 1500);
  // 判定した形式で、ジャンル × 期間ごとに 動画 / 配信 / ショート へ振り分け直す
  for (const g of [...GENRES.map(x => x.id), 'clip']) for (const p of ['7', '28', 'new']) {
    const fs = g === 'clip' ? ['video', 'short'] : ['video', 'stream', 'short'];
    if (!fs.some(f => pools[`${g}|${f}|${p}`])) continue;
    const all = [...new Set(fs.flatMap(f => pools[`${g}|${f}|${p}`] || []))];
    for (const f of fs) pools[`${g}|${f}|${p}`] = all.filter(id => videos[id] && fmtOf(videos[id]) === f);
  }

  // 3.5 AIによる精査（ルールで落とした動画も含めて判定し、AIの判定を優先）
  aiv = { ...(prev.aiv || {}) };
  const cand = [...new Set(Object.entries(pools).filter(([k]) => !k.startsWith('clip|')).flatMap(([, ids]) => ids))].filter(id => videos[id] && isJP(videos[id]) && !HANGUL.test(videos[id].title || ''));
  await screenVideos(cand, videos);
  for (const k of Object.keys(pools)) pools[k] = pools[k].filter(id => videos[id] && (k.startsWith('clip|') ? (isJP(videos[id]) && !META_BAD.test(videos[id].title)) : keepVideo(videos[id], k.split('|')[0])));
  const used = new Set(Object.values(pools).flat());
  for (const id of Object.keys(videos)) if (!used.has(id)) delete videos[id];

  // 4. 登録者推移・チャンネル台帳・チャンネルの注目動画（channelSteps）
  await channelSteps(subsNow);
}

// =====================================================================
// 4〜4.6 チャンネルまわり（通常の更新と「チャンネルだけ更新」で共通）
// =====================================================================
async function channelSteps(subsNow) {
  // 4. 登録者推移（日本時間の日付ごと、最大28日）
  histDays = Array.isArray(prev.histDays) ? prev.histDays.slice() : [];
  const prevSubs = prev.histDays ? (prev.subs || {}) : {};
  if (histDays[histDays.length - 1] !== day) histDays.push(day);
  const drop = Math.max(0, histDays.length - 28);
  histDays = histDays.slice(drop);
  // 4.5 チャンネル台帳：直近28日に出てきたVTuberチャンネル（切り抜き・関係ない動画のチャンネルは除く）
  //     台帳のチャンネルは、今日の検索に出てこなくても登録者数・総再生数を毎日記録する（チャンネルランキング用）
  chans = {};
  for (const [id, c] of Object.entries(prev.chans || {})) if (c && c.last && now - Date.parse(c.last) < 28 * 864e5) chans[id] = { ...c };
  const chG = {};
  for (const [k, ids] of Object.entries(pools)) { const g = k.split('|')[0]; if (g === 'clip' || g === 'all') continue; for (const id of ids) { const v = videos[id]; if (v) (chG[v.chId] = chG[v.chId] || new Set()).add(g); } }
  for (const v of Object.values(videos)) {
    if (isClip(v) || !keepVideo(v, 'all')) continue;
    const c = chans[v.chId] || {};
    chans[v.chId] = { ...c, n: v.ch, last: day, g: [...new Set([...(c.g || []), ...(chG[v.chId] || [])])] };
  }
  for (const id of Object.keys(chans)) if (/切り抜き|切抜き|きりぬき|clip|クリップ/i.test(chans[id].n || '') || CH_BAD.test(chans[id].n || '')) delete chans[id];
  await fetchChannels(Object.keys(chans), subsNow);
  for (const [id, c] of Object.entries(chans)) { const s = chStat[id]; if (s) { c.th = s.th || c.th || ''; c.vc = s.vc; if (s.n) c.n = s.n; } }
  console.log(`OK   チャンネル台帳: ${Object.keys(chans).length}チャンネル`);

  subs = {}; chv = {};
  const prevChv = prev.histDays ? (prev.chv || {}) : {};
  const usedCh = new Set([...Object.values(videos).map(v => v.chId), ...Object.keys(chans)]);
  for (const id of usedCh) {
    const old = (prevSubs[id] || []).slice(drop);
    const arr = histDays.map((_, i) => old[i] ?? null);
    if (subsNow[id] != null) arr[arr.length - 1] = subsNow[id];
    if (arr.some(x => x != null)) subs[id] = arr;
    if (!chans[id]) continue;
    // チャンネルの総再生数の推移（1日に増えた再生数＝今の勢い）
    const oldV = (prevChv[id] || []).slice(drop);
    const arrV = histDays.map((_, i) => oldV[i] ?? null);
    if (chStat[id] && chStat[id].views) arrV[arrV.length - 1] = chStat[id].views;
    if (arrV.some(x => x != null)) chv[id] = arrV;
  }

  // 4.6 チャンネルの注目動画：ランキング上位になりそうなチャンネル（登録者の規模ごとに45件・約300件）だけ、
  //     アップロード一覧の最新50本を見て「動画・ショート・配信」ごとに再生数の多い5本を保存（1チャンネル約2ユニット・2日おきに更新）
  chtop = {};
  for (const [id, t] of Object.entries(prev.chtop || {})) if (chans[id] && t && t.d && now - Date.parse(t.d) < 7 * 864e5) chtop[id] = t;
  const band = s => s == null ? -1 : s < 1e3 ? 0 : s < 3e3 ? 1 : s < 5e3 ? 2 : s < 1e4 ? 3 : s < 5e4 ? 4 : s < 2e5 ? 5 : 6;
  const vByCh = {}; for (const v of Object.values(videos)) if (!isClip(v)) (vByCh[v.chId] = vByCh[v.chId] || []).push(v);
  const momentum = id => {
    const a = (chv[id] || []).map((x, i) => [x, i]).filter(([x]) => x != null);
    if (a.length >= 2) return (a[a.length - 1][0] - a[0][0]) / (a[a.length - 1][1] - a[0][1]);
    return (vByCh[id] || []).reduce((s, v) => s + v.views / Math.max((now - Date.parse(v.published)) / 864e5, 1), 0);
  };
  const bands = {};
  for (const id of Object.keys(chans)) { const b = band(subsNow[id]); if (b >= 0) (bands[b] = bands[b] || []).push([id, momentum(id)]); }
  // 通常は規模ごとに45件。CH_ONLY（残りの枠を使う更新）では100件まで広げる
  const want = Object.values(bands).flatMap(l => l.sort((a, b) => b[1] - a[1]).slice(0, CH_ONLY ? 100 : 45).map(x => x[0]));
  const todoTop = want.filter(id => !chtop[id] || now - Date.parse(chtop[id].d) >= 2 * 864e5);
  const fetched = [];
  for (const id of todoTop) {
    // 通常：このあとの歴代名作の計測・ナレッジ用の検索（合計約1,000ユニット）の分を残しておく
    // CH_ONLY：その日の残りの枠の中で止める（このあとのナレッジ3本＝300ユニットを残して、合計 約2,100）
    if (units > (CH_ONLY ? 1800 : 8000)) { logErr('chtop', new Error('YouTubeの無料枠の残りが少ないため途中で止めました')); break; }
    try {
      const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: 'UU' + id.slice(2), maxResults: 50 }, 1);
      const ids = (pl.items || []).map(it => it.contentDetails && it.contentDetails.videoId).filter(Boolean);
      if (!ids.length) continue;
      const j = await yt('videos', { part: VPARTS, id: ids.join(',') }, 1);
      const items = (j.items || []).filter(it => it.snippet && it.snippet.liveBroadcastContent === 'none').map(it => {
        const st = it.statistics || {};
        return { id: it.id, t: String(it.snippet.title || '').slice(0, 90), v: +(st.viewCount || 0), l: +(st.likeCount || 0), c: +(st.commentCount || 0),
          p: it.snippet.publishedAt, dur: isoDur(it.contentDetails && it.contentDetails.duration), stream: isLive(it, isoDur(it.contentDetails && it.contentDetails.duration)),
          sh: (prev.videos && prev.videos[it.id] && prev.videos[it.id].sh) ?? (videos[it.id] && videos[it.id].sh) ?? null };
      });
      fetched.push([id, items]);
    } catch (e) { logErr(`chtop ${id}`, e); if (/quota/i.test(String(e.message))) break; }
  }
  await checkShorts(fetched.flatMap(([, items]) => items), 3000);
  for (const [id, items] of fetched) {
    const top = {};
    for (const f of ['video', 'short', 'stream']) top[f] = items.filter(v => fmtOf(v) === f).sort((a, b) => b.v - a.v).slice(0, 5)
      .map(v => ({ id: v.id, t: v.t, v: v.v, l: v.l, c: v.c, p: v.p, dur: v.dur }));
    chtop[id] = { d: day, n: items.length, ...top };
  }
  console.log(`OK   チャンネルの注目動画: ${fetched.length}チャンネルを更新（保存 ${Object.keys(chtop).length}チャンネル）`);
}

if (!AI_ONLY) {
  // -------------------------------------------------------------------
  // 5. 話題ワード（動画タイトルの【】『』#タグ）ジャンル × 形式 × 7日/28日
  // -------------------------------------------------------------------
  const STOP = new Set(['vtuber', 'vtubers', '新人vtuber', '個人vtuber', 'vtuber準備中', '新人vtuber準備中', 'shorts', 'short', 'ショート',
    '切り抜き', 'ホロライブ', 'にじさんじ', 'hololive', 'nijisanji', 'ぶいすぽ', 'ぶいすぽっ!', '歌ってみた', 'cover', 'covered by', '歌枠', '雑談', '雑談配信',
    'ゲーム実況', '実況', '初見', '初見プレイ', '初見実況', 'ネタバレ注意', '縦型配信', '縦型', '配信', 'live', 'ライブ配信', '生配信', '新人',
    'おすすめ', 'fyp', 'viral', '女性実況', '男性vtuber', '女性vtuber', 'vtuber好きと繋がりたい', 'jpvtuber', 'envtuber', 'music', 'mv',
    'ゲーム', '企画', 'shorts動画', 'youtube', 'youtubeshorts', 'ytshorts', 'trending', 'funny', 'anime', 'アニメ', 'live2d', '3d', 'asmr配信', 'vsinger',
    '個人勢', '個人勢vtuber', 'ゲーム配信', 'ホラーゲーム', 'ホラゲ', 'vtuber配信', '歌', 'singing', 'karaoke', 'ゲーム女子', '新人vtuberを発掘せよ']);
  ['ホラー','ホラゲー','ホラゲ実況','ホラーゲーム実況','音量注意','絶叫注意','閲覧注意','karaoke','singing','singingstream','twitch','steam','vlog','実況プレイ','ゲーム実況プレイ','歌い手','歌って','チャレンジ','罰ゲーム','pr','dance','イラスト','高音質','男性向け','女性向け','睡眠導入','寝息','吐息','心音','囁き','ear cleaning','耳かき','縦型','おもしろ','爆笑','バズれ','毎日投稿','毎日配信','初見さん大歓迎','初見さん歓迎','初見歓迎','朝活','夜活','手描き','animation','meme','ゲーム実況者','声真似','ネタバレあり','ネタバレ','作業用','睡眠用','高画質','4k','short動画','ショート動画','shortvideo','gaming','gameplay','vtuberclips','jpvtuber','vtuberjp'].forEach(w => STOP.add(w));
  const tokenize = title => {
    const t = String(title || '').normalize('NFKC').replace(/[​-‏⁠﻿]/g, '');
    const out = new Map();
    const add = w => {
      w = w.replace(/^[\s#【】「」『』\[\]()（）〚〛《》:：]+|[\s#【】「」『』\[\]()（）〚〛《》:：]+$/g, '').replace(/\s+/g, ' ');
      const k = w.toLowerCase();
      if (w.length < 2 || w.length > 24 || /^[\d\s.\-#]+$/.test(w) || STOP.has(k) || /切り抜き$|vtuber$|^vtuber|vtuber準備|新人|個人勢|初見/.test(k)) return;
      if (!out.has(k)) out.set(k, w);
    };
    for (const m of t.matchAll(/【([^】]+)】/g)) m[1].split(/[\/|・,、#]+/).forEach(add);
    for (const m of t.matchAll(/『([^』]+)』/g)) add(m[1]);
    for (const m of t.matchAll(/#([^\s#【】]+)/g)) add(m[1]);
    return out;
  };
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const buildTokens = (ids, topN) => {
    const agg = new Map();
    const normCh = s => String(s || '').normalize('NFKC').toLowerCase().replace(/\s/g, '');
    for (const id of ids) {
      const v = videos[id]; if (!v || isClip(v)) continue;
      const chn = normCh(v.ch);
      for (const [k, w] of tokenize(v.title)) {
        // チャンネル名・人名（自分の名前を【】に入れているもの）はワードにしない
        const kn = k.replace(/\s/g, '');
        if (kn.length >= 2 && (chn.includes(kn) || kn.includes(chn))) continue;
        const a = agg.get(k) || { ids: [], forms: {} };
        a.ids.push(id); a.forms[w] = (a.forms[w] || 0) + 1;
        agg.set(k, a);
      }
    }
    let list = [...agg.entries()].map(([k, a]) => {
      // 同じチャンネルの重複は1本として数える
      const chs = new Set(a.ids.map(id => videos[id].chId));
      const vs = a.ids.map(id => videos[id]);
      const views = vs.reduce((s, v) => s + v.views, 0);
      const med = median(vs.map(v => v.views));
      const w = Object.entries(a.forms).sort((x, y) => y[1] - x[1])[0][0];
      const fm = { video: 0, stream: 0, short: 0 };
      vs.forEach(v => { fm[fmtOf(v)]++; });
      return { k, w, n: a.ids.length, nch: chs.size, views, fm, score: chs.size * Math.log10(10 + med),
        top: a.ids.slice().sort((x, y) => videos[y].views - videos[x].views).slice(0, topN) };
    });
    list.sort((a, b) => (b.nch >= 2) - (a.nch >= 2) || b.score - a.score);
    return list.slice(0, 50).map(t => { delete t.score; return t; });
  };
  tokens = {}; tokens2 = {}; tokHist = {};
  for (const g of GENRES) {
    const prevH = (prev.tokHist && prev.tokHist[g.id]) || {};
    const hist = {};
    for (const fid of ['all', 'video', 'stream', 'short']) {
      for (const p of ['7', '28']) {
        const ids = new Set();
        for (const f of FORMATS) {
          if (fid !== 'all' && f.id !== fid) continue;
          for (const src of (p === '7' ? ['7', 'new'] : ['28', '7', 'new'])) (pools[`${g.id}|${f.id}|${src}`] || []).forEach(id => ids.add(id));
        }
        const list = buildTokens([...ids], fid === 'all' && p === '7' ? 12 : 8);
        // 前回までとの比較で「新登場・急上昇・定番・下降」
        for (const t of list) {
          const h = (prevH[t.k] || []).slice(-13);
          const avg = h.length ? h.reduce((s, x) => s + x, 0) / h.length : 0;
          t.st = !h.length ? 'new' : t.n >= avg * 1.5 ? 'up' : t.n <= avg * 0.6 ? 'down' : 'steady';
          t.prev = h.length ? Math.round(avg * 10) / 10 : null;
          if (fid === 'all' && p === '7') hist[t.k] = [...h, t.n];
        }
        tokens2[`${g.id}|${fid}|${p}`] = list;
      }
    }
    tokens[g.id] = tokens2[`${g.id}|all|7`];
    tokHist[g.id] = hist;
  }

  // -------------------------------------------------------------------
  // 5.5 流行アーカイブ：毎日の話題ワードを貯める（2026年以降の流行として残る）
  // -------------------------------------------------------------------
  archive = prev.archive || {};
  for (const g of GENRES) {
    if (g.id === 'all') continue;
    for (const t of (tokens[g.id] || []).filter(t => t.nch >= 2)) {
      const key = `${g.id}|${t.k}`;
      const a = archive[key] || { g: g.id, k: t.k, w: t.w, first: day, peak: 0, days: 0, hist: {}, styles: {} };
      a.w = t.w; a.last = day;
      if (!a.hist[day]) a.days++;
      a.hist[day] = t.n;
      const hk = Object.keys(a.hist).sort(); if (hk.length > 60) for (const d of hk.slice(0, hk.length - 60)) delete a.hist[d];
      a.peak = Math.max(a.peak, t.n);
      a.fm = t.fm; a.st = t.st;
      a.top = t.top.slice(0, 8).map(id => { const v = videos[id]; return { id, title: v.title, ch: v.ch, views: v.views, subs: v.subs, f: fmtOf(v), p: v.published }; });
      const st = {};
      t.top.forEach(id => styleOf(videos[id].title).forEach(s => { st[s] = (st[s] || 0) + 1; }));
      for (const [s, n] of Object.entries(st)) a.styles[s] = Math.max(a.styles[s] || 0, n);
      archive[key] = a;
    }
  }
  // 古すぎるもの（最終確認から2年以上）は削除、最大3000件
  const keys = Object.keys(archive).sort((x, y) => (archive[y].last || '').localeCompare(archive[x].last || ''));
  for (const k of keys.slice(3000)) delete archive[k];
  for (const k of Object.keys(archive)) if (Date.parse(archive[k].last) < now - 730 * 864e5) delete archive[k];
}

// =====================================================================
// B. 検索ワード・新作ゲーム・歴代名作（YouTubeの枠をほとんど使わない）
// =====================================================================
{
  // 6. YouTube検索候補：ジャンル × 形式
  const suggest = async q => {
    const u = 'https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&hl=ja&gl=jp&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const text = new TextDecoder('utf-8').decode(await r.arrayBuffer());
    const j = JSON.parse(text);
    return Array.isArray(j[1]) ? j[1] : [];
  };
  const old = suggestOut || prev.suggest || {};
  suggestOut = {};
  const SEEDS = ['', ' ', ' あ', ' い', ' か', ' さ', ' た', ' な', ' は', ' ま', ' や', ' ら', ' a', ' s'];
  for (const g of GENRES) {
    for (const f of FORMATS) {
      const key = `${g.id}|${f.id}`;
      const bases = (g.id === 'all' ? ['vtuber'] : ['vtuber ' + g.sk, g.sk + ' vtuber']).map(b => b + f.sfx);
      const score = new Map();
      try {
        for (const base of bases) {
          for (const [si, s] of SEEDS.entries()) {
            (await suggest(base + s)).forEach((w, i) => {
              const k = w.trim().toLowerCase();
              if (!k || k === base.toLowerCase()) return;
              score.set(k, (score.get(k) || 0) + (10 - i) * (si <= 1 ? 3 : 1));
            });
            await sleep(150);
          }
        }
        // 50件に届かないときは、出てきた候補をさらに検索して広げる
        for (const w of [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0])) {
          if (score.size >= 70) break;
          (await suggest(w + ' ')).forEach((x, i) => {
            const k = x.trim().toLowerCase();
            if (k && k !== w) score.set(k, (score.get(k) || 0) + (10 - i) * 0.5);
          });
          await sleep(150);
        }
        suggestOut[key] = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([w, s]) => ({ w, s }));
        console.log(`OK   suggest ${key}: ${suggestOut[key].length}件`);
      } catch (e) {
        logErr(`suggest ${key}`, e);
        suggestOut[key] = old[key] || old[g.id] || [];
      }
    }
  }

  // 6.1 Googleトレンド（日本）：毎日貯めて最大50件
  const prevG = gtrends || prev.gtrends || [];
  try {
    const xml = await (await fetch('https://trends.google.co.jp/trending/rss?geo=JP', { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
    const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
    const today = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const w = dec((/<title>([\s\S]*?)<\/title>/.exec(m[1]) || [])[1] || '');
      const tr = dec((/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/.exec(m[1]) || [])[1] || '');
      const news = dec((/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/.exec(m[1]) || [])[1] || '');
      if (w) today.push({ w, traffic: tr, news, d: day });
    }
    const todayW = new Set(today.map(t => t.w));
    gtrends = [...today, ...prevG.filter(t => !todayW.has(t.w))].slice(0, 50);
    console.log(`OK   google trends: ${gtrends.length}件（今日 ${today.length}件）`);
  } catch (e) { logErr('google trends', e); gtrends = prevG; }

  // 6.5 新作ゲーム（Steam：キー不要）発売予定 / 最近発売 × ジャンル 各50件
  const STEAM_G = [
    { id: 'all', tag: null }, { id: 'action', tag: 19 }, { id: 'adventure', tag: 21 }, { id: 'rpg', tag: 122 },
    { id: 'coop', tag: 1685 }, { id: 'sim', tag: 599 }, { id: 'horror', tag: 1667 },
  ];
  const SH = { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ja' };
  const oldApps = (prev.steam && prev.steam.apps) || {};
  const prevSteam = prev.steam || { soon: {}, new: {} };
  steam = { soon: {}, new: {}, apps: {} };
  let fetched = 0;
  async function appInfo(id) {
    const o = oldApps[id];
    if (o && (o.err || Date.now() - Date.parse(o.got) < 5 * 864e5)) return o; // 5日間は再利用
    if (fetched >= 380) return o || null; // 1回の実行で取りに行く上限
    fetched++;
    await sleep(1400);
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
  // 発売予定と最近発売をジャンルごとに交互に取得（どちらかが空にならないように）
  for (const g of STEAM_G) {
    for (const [mode, filter] of [['soon', 'popularcomingsoon'], ['new', 'popularnew']]) {
      try {
        const u = `https://store.steampowered.com/search/results/?query&start=0&count=80&filter=${filter}&infinite=1&cc=JP&l=japanese&ignore_preferences=1${g.tag ? '&tags=' + g.tag : ''}`;
        const j = await (await fetch(u, { headers: SH })).json();
        const ids = [...new Set([...(j.results_html || '').matchAll(/data-ds-appid="(\d+)/g)].map(m => m[1]))];
        const list = [];
        for (const id of ids) {
          if (list.length >= 50) break;
          const a = await appInfo(id);
          if (!a || a.err || a.adult) { if (a) steam.apps[id] = a; continue; }
          steam.apps[id] = a; list.push(id);
        }
        // 取りきれなかった分は前回のリストで補う
        for (const id of ((prevSteam[mode] || {})[g.id] || [])) { if (list.length >= 50) break; if (!list.includes(id) && oldApps[id] && !oldApps[id].err && !oldApps[id].adult) { list.push(id); steam.apps[id] = oldApps[id]; } }
        steam[mode][g.id] = list;
        console.log(`OK   steam ${mode} ${g.id}: ${list.length}件`);
      } catch (e) { logErr(`steam ${mode} ${g.id}`, e); steam[mode][g.id] = (prevSteam[mode] || {})[g.id] || []; }
    }
  }

  // 6.6 歴代名作の「YouTubeでよく見られている度」（1日8作品ずつ計測、AI_ONLY のときはスキップ）
  if (!AI_ONLY) try {
    const list = JSON.parse(await readFile(new URL('../classics.json', import.meta.url), 'utf8'));
    const order = list.slice().sort((a, b) => (classic[a.id] ? Date.parse(classic[a.id].d) : 0) - (classic[b.id] ? Date.parse(classic[b.id].d) : 0));
    for (const c of order.slice(0, 8)) {
      try {
        const s = await yt('search', { part: 'snippet', type: 'video', q: c.q, maxResults: 50, order: 'viewCount', regionCode: 'JP', relevanceLanguage: 'ja' }, 100);
        const ids = (s.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
        const vj = ids.length ? await yt('videos', { part: 'snippet,statistics', id: ids.join(',') }, 1) : { items: [] };
        // タイトルにゲーム名（検索ワードの先頭 or 正式名称）が入っている動画だけで計測
        const nn = s => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s:：・!！?？\-–—'’"]/g, '');
        const keys = [nn(c.q.split(' ')[0]), nn(c.name).slice(0, 8)].filter(k => k.length >= 2);
        const vs = (vj.items || []).map(v => ({ id: v.id, title: v.snippet.title, ch: v.snippet.channelTitle, views: +(v.statistics.viewCount || 0) }))
          .filter(v => KANA.test(v.title) && keys.some(k => nn(v.title).includes(k))).sort((a, b) => b.views - a.views);
        classic[c.id] = { views: vs.reduce((t, v) => t + v.views, 0), n: vs.length, top: vs.slice(0, 5), d: new Date().toISOString() };
        console.log(`OK   classic ${c.id}: ${classic[c.id].views}`);
      } catch (e) { logErr(`classic ${c.id}`, e); }
    }
  } catch (e) { logErr('classics.json', e); }
}

// =====================================================================
// C. Gemini（任意）
// =====================================================================
async function pickModel() {
  try {
    const j = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEM}&pageSize=200`)).json();
    if (j.error) throw new Error(j.error.message);
    const names = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
    diag.models = names.slice(0, 80);
    const ver = n => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? +m[1] : 0; };
    const NG = /image|tts|live|audio|thinking|embedding|omni|transcribe|robotics|computer|customtools|nano|banana/;
    const pick = (re, notRe) => names.filter(n => /^gemini-/.test(n) && re.test(n) && !NG.test(n) && !(notRe && notRe.test(n))).sort((a, b) => ver(b) - ver(a) || a.length - b.length);
    // 使う順番（運営の指定）：3.8 Flash → 3.6 Flash → 3.5 Flash Lite → 3.1 Flash Lite
    const list = [
      process.env.GEMINI_MODEL,
      'gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
    ].filter((n, i, a) => n && names.includes(n) && a.indexOf(n) === i);
    // 4つとも一覧に無いときだけ、ほかの Flash 系を予備に使う
    if (!list.length) list.push(...pick(/flash/, /preview|exp/));
    MODELS = list.length ? list : ['gemini-flash-latest'];
  } catch (e) { logErr('gemini models', e); MODELS = [process.env.GEMINI_MODEL || 'gemini-flash-latest']; }
  diag.modelList = MODELS.slice(0, 12);
  return MODELS[0] || 'gemini-flash-latest';
}
function chooseModel(tier) {
  const order = tier === 'high' ? [...TIER.high, ...TIER.lite] : [...TIER.lite, ...TIER.high];
  const ok = m => MODELS.includes(m) && !deadModels.has(m) && (usedCalls[m] || 0) < (LIMITS[m] ?? 999);
  return order.find(ok) || MODELS.find(ok) || null;
}
async function gemini(parts, { search = false, tier = 'lite', lowMedia = false, deadline = AI_DEADLINE } = {}) {
  const body = { contents: [{ parts }], generationConfig: { temperature: 0.4 } };
  if (search) body.tools = [{ google_search: {} }];
  else body.generationConfig.responseMimeType = 'application/json';
  // 映像を見せるときは画質を落として、無料枠の量（トークン）を節約する
  if (lowMedia) body.generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  // GitHub の実行時間の上限（45分）までに保存できるよう、開始から33分を過ぎたらAIは使わない（メンバーの配信分析は40分まで）
  if (Date.now() - now > deadline) throw new Error('時間切れ：AIの処理を打ち切りました（保存を優先）');
  const waited = new Map();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (Date.now() - now > deadline) throw new Error('時間切れ：AIの処理を打ち切りました（保存を優先）');
    const model = chooseModel(tier);
    if (!model) throw new Error('使えるAIモデルがありません（すべて回数を使い切った・混雑・使えないモデル）');
    if (model !== MODEL) { console.log(`AIモデル: ${model}（${tier === 'high' ? '高性能' : '軽量'}の仕事）`); MODEL = model; }
    // 同じモデルを続けて呼ぶときは間をあける（高性能は1分に5回まで、軽量は15回までの想定）
    const gap = (model.includes('lite') ? 4500 : 13000) - (Date.now() - (lastCall[model] || 0));
    if (gap > 0) await sleep(gap);
    lastCall[model] = Date.now();
    usedCalls[model] = (usedCalls[model] || 0) + 1;
    diag.usage = { ...usedCalls };
    let j;
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEM}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      j = await r.json();
    } catch (e) { j = { error: { message: String(e && e.message || e), code: 503 } }; }
    if (!j.error) {
      const cand = (j.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).map(p => p.text || '').join('');
      const chunks = ((cand.groundingMetadata && cand.groundingMetadata.groundingChunks) || []).map(c => c.web).filter(Boolean);
      return { data: parseJSON(text), chunks };
    }
    const msg = String(j.error.message || ''), code = j.error.code;
    // 使えないモデル（新規ユーザーは使えない・提供終了・見つからない など）
    const gone = code === 404 || code === 403 || /no longer available|not found|not supported|deprecated|permission/i.test(msg);
    const busy = !gone && (code === 503 || code === 500 || /high demand|overloaded|unavailable|try again later|internal/i.test(msg));
    const quota = !gone && (code === 429 || /quota|exhausted|rate.?limit/i.test(msg));
    if (!busy && !quota && !gone) throw new Error(msg);
    // 混雑・上限で断られた呼び出しは、回数に数えない
    if (busy || quota) { usedCalls[model]--; diag.usage = { ...usedCalls }; }
    // どの上限に当たったか（1分あたり／1日あたり）と、何秒待てばよいかを、エラーの詳しい情報から読む
    const det = Array.isArray(j.error.details) ? j.error.details : [];
    const qids = det.flatMap(x => x.violations || []).map(v => v.quotaId || v.quotaMetric || '').filter(Boolean);
    const rd = (det.find(x => x.retryDelay) || {}).retryDelay, m = /retry in ([\d.]+)s/i.exec(msg);
    const waitS = rd ? parseFloat(rd) : m ? +m[1] : null;
    const perDay = qids.some(q => /PerDay/i.test(q)), perMin = !perDay && (qids.some(q => /PerMinute/i.test(q)) || waitS != null);
    // 混雑：最大3回まで待ってやり直す（20秒→40秒→60秒）
    // 1分あたりの上限（回数・トークン量）：言われた秒数だけ待って、最大3回までやり直す（1日あたりの上限なら次のモデルへ）
    const n = waited.get(model) || 0;
    if (busy && n < 3) { waited.set(model, n + 1); await sleep((n + 1) * 20000); continue; }
    if (quota && perMin && n < 3) { waited.set(model, n + 1); const s = Math.min(Math.max(waitS || 30, 5), 90); console.log(`AIモデル ${model}：1分あたりの上限のため ${Math.round(s)}秒待ちます`); await sleep((s + 2) * 1000); continue; }
    // それでもだめなら、このモデルは今回は使わず次のモデルへ
    deadModels.add(model);
    const why = gone ? '使えないモデル' : busy ? '混雑' : perDay ? '1日の無料枠' : '無料枠';
    console.log(`AIモデル ${model} を外しました（${why}）${qids.length ? ' ' + qids.join(',') : ''}`);
    if (diag.switches == null) diag.switches = [];
    if (diag.switches.length < 20) diag.switches.push(`${model}（${why}: ${qids.join(',') || '-'}／${msg.slice(0, 200)}）`);
    // 原因を調べられるよう、Googleから返ってきたエラーをそのまま残す（キーは含まれない）
    if (diag.rawErrors == null) diag.rawErrors = [];
    if (diag.rawErrors.length < 6) diag.rawErrors.push({ model, at: new Date().toISOString(), error: JSON.stringify(j.error).slice(0, 1500) });
  }
  throw new Error('AIの再試行の上限に達しました');
}
// =====================================================================
// C-5. メンバーの配信を映像で分析
//   ・members.json に書いたチャンネルの、最近の配信・動画（10分以上）が対象
//   ・Gemini に映像を30分ずつ見せて（画質を落として節約）、5分ごとの中身と「見どころの瞬間」を書いてもらう
//   ・チャットのリプレイ（キー不要）を数えて盛り上がりを出す
//   ・全部の区間が終わったら、高性能モデルで「流れ・見どころ・話題・切り抜き案」にまとめる
//   ・1日に映像を見せるのは MY_CALLS 回まで。終わらなかった分は次の日に続きから
// =====================================================================
const MY_CALLS = 10, MY_CHUNK = 1800, MY_DEADLINE = 40 * 60e3;
const myDeep = (prev.my && typeof prev.my === 'object') ? prev.my : {};
// メンバーの公開の数字（登録者・最近の動画の再生や高評価）。サイトでログインしていなくても見られるようにする
const myPub = (prev.mypub && typeof prev.mypub === 'object') ? prev.mypub : {};
const hms = s => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const toSec = t => typeof t === 'number' ? t : String(t || '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);
async function fetchChat(id) {
  const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'ja-JP,ja;q=0.9' };
  const html = await (await fetch(`https://www.youtube.com/watch?v=${id}&hl=ja`, { headers: H })).text();
  const cv = (/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html) || [])[1];
  let c = (/"liveChatRenderer":\{"continuations":\[\{"reloadContinuationData":\{"continuation":"([^"]+)"/.exec(html) || [])[1];
  if (!c || !cv) return null; // チャットのリプレイがない（普通の動画・チャットなし）
  const seen = new Set(), msgs = new Map();
  for (let n = 0; c && !seen.has(c) && n < 300; n++) {
    seen.add(c);
    const r = await fetch('https://www.youtube.com/youtubei/v1/live_chat/get_live_chat_replay?prettyPrint=false', {
      method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: cv, hl: 'ja', gl: 'JP' } }, continuation: c }) });
    if (!r.ok) break;
    const lc = ((await r.json()).continuationContents || {}).liveChatContinuation || {};
    for (const a of lc.actions || []) {
      const ra = a.replayChatItemAction; if (!ra) continue;
      for (const it of ra.actions || []) {
        const m = it.addChatItemAction && it.addChatItemAction.item && it.addChatItemAction.item.liveChatTextMessageRenderer;
        if (!m || !m.message) continue;
        const text = (m.message.runs || []).map(x => x.text || (x.emoji && (x.emoji.shortcuts || [])[0]) || '').join('');
        msgs.set(m.id, [Math.round(+(ra.videoOffsetTimeMsec || 0) / 1000), (m.authorName && m.authorName.simpleText) || '', text.slice(0, 80)]);
      }
    }
    c = (((lc.continuations || [])[0] || {}).liveChatReplayContinuationData || {}).continuation;
    await sleep(300);
  }
  return [...msgs.values()].sort((a, b) => a[0] - b[0]);
}
async function memberSteps() {
  let members = [];
  try { members = JSON.parse(await readFile(new URL('../members.json', import.meta.url), 'utf8')); } catch (e) { logErr('members.json', e); return; }
  // 1. メンバーの最近の配信・動画（YouTube APIは1人2ユニット）
  const list = [];
  for (const m of members) {
    try {
      const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: 'UU' + m.cid.slice(2), maxResults: 15 }, 1);
      const ids = (pl.items || []).map(x => x.contentDetails.videoId);
      if (!ids.length) continue;
      const vj = await yt('videos', { part: 'snippet,contentDetails,liveStreamingDetails,statistics', id: ids.join(',') }, 1);
      // 公開の数字（チャンネル情報は1人1ユニット）
      try {
        const cj = await yt('channels', { part: 'snippet,statistics', id: m.cid }, 1), c = cj.items && cj.items[0];
        if (c) myPub[m.cid] = { asOf: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), name: c.snippet.title, handle: c.snippet.customUrl || '',
          th: ((c.snippet.thumbnails || {}).default || {}).url || '', desc: c.snippet.description || '',
          subs: c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount, vcount: +c.statistics.videoCount || 0,
          videos: (vj.items || []).filter(v => v.snippet.liveBroadcastContent === 'none').map(v => { const dur = isoDur(v.contentDetails.duration), live = v.liveStreamingDetails;
            return { id: v.id, fmt: isLive(v, dur) ? 'stream' : dur <= 180 ? 'short' : 'video', title: v.snippet.title, at: (live && live.actualStartTime) || v.snippet.publishedAt, dur,
              views: +v.statistics.viewCount || 0, likes: v.statistics.likeCount != null ? +v.statistics.likeCount : null }; }) };
      } catch (e) { logErr(`member channel ${m.name}`, e); }
      for (const v of vj.items || []) {
        const dur = isoDur(v.contentDetails.duration), live = v.liveStreamingDetails;
        if (v.snippet.liveBroadcastContent !== 'none' || dur < 600) continue; // 配信中・予定・10分未満は対象外
        if (/メン限|メンバー限定|members only/i.test(v.snippet.title)) continue; // メンバー限定はAIが見られない
        const x = myDeep[v.id] = myDeep[v.id] || { cid: m.cid, name: m.name, chunks: Math.ceil(dur / MY_CHUNK), done: 0, seg: [], mom: [] };
        Object.assign(x, { title: v.snippet.title, dur, at: (live && live.actualStartTime) || v.snippet.publishedAt, stream: isLive(v, dur), views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0 });
        list.push(v.id);
      }
    } catch (e) { logErr(`member list ${m.name}`, e); }
  }
  // 2. 新しい順に、終わっていない配信の続きを分析
  const todo = list.filter(id => !myDeep[id].deep && !myDeep[id].skip).sort((a, b) => Date.parse(myDeep[b].at) - Date.parse(myDeep[a].at));
  let calls = 0;
  for (const id of todo) {
    const x = myDeep[id], url = `https://www.youtube.com/watch?v=${id}`;
    // チャット（最初の1回だけ集める）
    if (!x.chatDone) {
      try {
        const msgs = await fetchChat(id);
        if (msgs) {
          const n10 = Math.ceil(x.dur / 600), cnt = new Array(n10).fill(0);
          msgs.forEach(([s]) => cnt[Math.min(n10 - 1, Math.floor(s / 600))]++);
          x.chat = cnt; x.chatN = msgs.length; x.people = new Set(msgs.map(m => m[1])).size;
          x.lines = msgs.slice(0, 400); // まとめが終わったら消す
        }
        x.chatDone = 1;
      } catch (e) { logErr(`member chat ${id}`, e); x.chatDone = 1; }
    }
    // 30分ずつ映像を見せる
    while (x.done < x.chunks && calls < MY_CALLS && Date.now() - now < MY_DEADLINE) {
      const s = x.done * MY_CHUNK, e = Math.min(x.dur, s + MY_CHUNK);
      const chat = (x.lines || []).filter(m => m[0] >= s && m[0] < e).slice(0, 80).map(m => `${hms(m[0])} ${m[2]}`).join('\n');
      try {
        calls++;
        const { data } = await gemini([
          { file_data: { file_uri: url }, video_metadata: { start_offset: `${s}s`, end_offset: `${e}s`, fps: 0.5 } },
          { text: `これはYouTubeの${x.stream ? '配信' : '動画'}「${x.title}」の ${hms(s)}〜${hms(e)} の部分です。` +
            '映像と音声を見て、5分ごとに区切って何が起きているかを日本語で書いてください。ゲームなら場面（ボス戦・ムービー・探索・メニュー・レベル上げ など）と、映像として見ごたえがある瞬間（大技・召喚・変身・巨大な敵・きれいな景色・名シーンのムービー・大きなリアクション）を重視してください。\n' +
            '時間は「この部分の最初を0秒」とした秒数（整数）で書いてください。\n' +
            '出力はJSONのみ: {"seg":[{"s":0,"scene":"場面（10文字以内）","what":"何が起きているか（1〜2文）","talk":"配信者が話している話題（なければ空）","look":0〜5の映像の見ごたえ,"hype":0〜5の盛り上がり}],' +
            '"mom":[{"s":秒,"what":"見どころの瞬間（20文字以内）","why":"なぜ見ごたえがあるか・切り抜きに向くか（1文）","look":1〜5}]}\n' +
            'seg は5分ごと（0, 300, 600 …）、mom はこの部分の中で特に見ごたえがある瞬間を0〜5個。' +
            (chat ? `\n\n参考：この時間のチャット（時間は配信の最初から）\n${chat}` : '') }
        ], { tier: 'lite', lowMedia: true, deadline: MY_DEADLINE });
        if (!data || !Array.isArray(data.seg)) throw new Error('映像の分析結果が空');
        data.seg.forEach(g => x.seg.push({ t: hms(s + toSec(g.s)), scene: String(g.scene || '').slice(0, 20), what: String(g.what || '').slice(0, 160), talk: String(g.talk || '').slice(0, 100), look: +g.look || 0, hype: +g.hype || 0 }));
        (data.mom || []).forEach(g => x.mom.push({ t: hms(s + toSec(g.s)), what: String(g.what || '').slice(0, 40), why: String(g.why || '').slice(0, 120), look: +g.look || 0 }));
        x.done++;
        console.log(`OK   member video ${id} ${hms(s)}〜${hms(e)}`);
      } catch (err) {
        logErr(`member video ${id} ${hms(s)}`, err);
        // 無料枠を使い切った・時間切れのときは、今日はここまで
        if (/使えるAIモデル|時間切れ|再試行の上限/.test(String(err.message))) calls = MY_CALLS;
        // 見られない動画（非公開・メンバー限定など）は次から飛ばす
        if (/permission|private|not available|unavailable|invalid|unsupported/i.test(String(err.message)) && !/high demand|overloaded/i.test(String(err.message))) x.skip = 1;
        break;
      }
      await sleep(30000); // 1分あたりの量の上限に引っかからないように間をあける
    }
    // 3. 全部の区間が終わったら、流れ・見どころ・話題・切り抜き案にまとめる
    if (x.done >= x.chunks && !x.deep && Date.now() - now < MY_DEADLINE) {
      try {
        const segs = x.seg.map(g => `${g.t}｜${g.scene}｜${g.what}${g.talk ? '｜話題:' + g.talk : ''}｜見ごたえ${g.look}・盛り上がり${g.hype}`).join('\n');
        const moms = x.mom.map(g => `${g.t}｜${g.what}｜${g.why}｜見ごたえ${g.look}`).join('\n');
        const chatTxt = (x.lines || []).slice(0, 250).map(m => `${hms(m[0])} ${m[2]}`).join('\n');
        const { data } = await gemini([{ text:
          `あなたはVTuberの配信プロデューサー兼切り抜き編集者です。次は${x.stream ? '配信' : '動画'}「${x.title}」（長さ ${hms(x.dur)}・再生${x.views}回・高評価${x.likes}）の分析メモです。\n` +
          '5分ごとの映像の中身・見どころの瞬間・チャットをもとに、日本語でまとめてください。時間は "h:mm:ss" で、メモにある時間だけを使ってください。推測は「〜と考えられる」と書いてください。\n' +
          '出力はJSONのみ: {"flow":[["開始","終了","場面の名前","何をしていたか"]],"vis":[["時間","映像で見ごたえがある所","なぜ見ごたえがあるか"]],' +
          '"topics":[["時間","話した話題"]],"sat":["満足度が高かったと考えられる所（理由つき）"],"hot":[["開始","終了","盛り上がった内容"]],"quiet":[["開始","終了","静かだった・離れやすい理由"]],' +
          '"clips":[["開始","終了","ショート または 切り抜き（◯〜◯分）","タイトル案","この範囲を選んだ理由"]],"viewers":"見ていた人の様子（1文）"}\n' +
          'flow は5〜12個、vis は3〜7個、topics は3〜10個、sat は2〜4個、hot は2〜4個、quiet は1〜3個、clips は3〜6個（ショートは映像の見ごたえ＋反応がそろった所を優先、60秒前後に収まる範囲。切り抜きは話題のまとまり）。\n\n' +
          `【5分ごとの中身】\n${segs}\n\n【見どころの瞬間】\n${moms || 'なし'}\n\n【10分ごとのチャット数】${(x.chat || []).join(',') || 'チャットなし'}\n\n【チャット】\n${chatTxt || 'なし'}` }], { tier: 'high', deadline: MY_DEADLINE });
        if (!data || !Array.isArray(data.clips)) throw new Error('まとめの結果が空');
        x.deep = { ...data, chat: x.chat, src: `映像：Geminiが30分ずつ見て5分ごとに確認（${x.seg.length}区間）／チャット：${x.chatN ? `${x.chatN}件（${x.people}人）` : 'なし'}` };
        x.d = day; delete x.lines;
        console.log(`OK   member deep ${id}`);
      } catch (err) { logErr(`member deep ${id}`, err); }
    }
    if (calls >= MY_CALLS || Date.now() - now > MY_DEADLINE) break;
  }
  // 古いものは消す（最新60本だけ残す）
  Object.keys(myDeep).sort((a, b) => Date.parse(myDeep[b].at || 0) - Date.parse(myDeep[a].at || 0)).slice(60).forEach(id => delete myDeep[id]);
  diag.member = { videos: list.length, calls, todo: todo.length };
}

// CH_ONLY のときはAIを使わず、前回のAIの結果をそのまま残す
const aiBuzz = CH_ONLY ? (prev.aiBuzz || {}) : {};
const aiTok = CH_ONLY ? (prev.aiTok || {}) : {};
let insight = null;
let notes = Array.isArray(prev.notes) ? prev.notes.slice() : [];
const ratioOf = v => v.subs ? v.views / v.subs : 0;
if (GEM) {
  if (!MODEL) MODEL = await pickModel();
  diag.model = MODEL;
  console.log(`AIモデル: ${MODEL}`);

  // いちばん大事な AI分析（C-4）を最初に作る
  await runInsight();

  // CH_ONLY のときは C-1・C-2・C-4 はしない（ナレッジ記事だけ追加で作る）
  if (!CH_ONLY) {
  // C-1. バズ動画の理由（ジャンルごと上位10本）。全ジャンル分を1回の呼び出しでまとめて作る。過去に書いたものは再利用
  const oldBuzz = prev.aiBuzz || {};
  const buzzTodo = new Map();
  for (const g of GENRES) {
    const ids = new Set();
    for (const f of FORMATS) for (const p of ['7', 'new']) (pools[`${g.id}|${f.id}|${p}`] || []).forEach(id => ids.add(id));
    const top = [...ids].map(id => videos[id]).filter(v => v && v.subs && v.views >= 10000 && !isClip(v)).sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, 10);
    // くわしい形（オブジェクト）で書いたものだけ再利用。前の短い文（文字列）は、くわしく書き直す対象にする（新しい動画を優先）
    top.forEach(v => { if (oldBuzz[v.id]) aiBuzz[v.id] = oldBuzz[v.id]; if (!oldBuzz[v.id] || typeof oldBuzz[v.id] === 'string') buzzTodo.set(v.id, v); });
  }
  if (buzzTodo.size) {
    // 比べるための数字：同じ形式の「再生÷登録者」の中央値、同じチャンネルのほかの動画の再生の中央値
    const med = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
    const all = Object.values(videos).filter(x => !isClip(x));
    const fmtMed = {}; for (const f of ['video', 'short', 'stream']) fmtMed[f] = med(all.filter(x => fmtOf(x) === f).map(ratioOf));
    const jst = t => { const d = new Date(Date.parse(t) + 9 * 3600e3); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${'日月火水木金土'[d.getUTCDay()]}) ${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`; };
    const line = v => { const f = fmtOf(v), mine = all.filter(x => x.chId === v.chId && x.id !== v.id && fmtOf(x) === f);
      return `${v.id} | ${v.title} | ${v.ch} | ${f === 'stream' ? '配信アーカイブ' : f === 'short' ? 'ショート' : '動画'} | 長さ${Math.round((v.dur || 0) / 60)}分 | 公開 ${jst(v.published)}（${Math.max(1, Math.round((now - Date.parse(v.published)) / 864e5))}日前） | 登録者${v.subs} | 再生${v.views}（登録者の${ratioOf(v).toFixed(1)}倍。同じ形式の真ん中は${(fmtMed[f] || 0).toFixed(1)}倍） | 高評価${v.likes}（${(v.likes / Math.max(v.views, 1) * 100).toFixed(1)}%） | コメント${v.comments}`
        + (mine.length ? ` | 同じチャンネルの同じ形式${mine.length}本の再生の真ん中${med(mine.map(x => x.views))}` : ''); };
    // 1回12本まで・1日2回まで（無料枠のため）。新しく入った動画を先に
    const order = [...buzzTodo.values()].sort((a, b) => (typeof oldBuzz[a.id] === 'string') - (typeof oldBuzz[b.id] === 'string'));
    for (let i = 0; i < Math.min(order.length, 24); i += 12) {
      const batch = order.slice(i, i + 12);
      try {
        const { data } = await gemini([{ text:
          'あなたはVTuber・YouTubeのアナリストです。次の動画それぞれについて「なぜ伸びたのか」を、小さなVTuberがまねできるくらい具体的に分析してください。' +
          'Google検索で、その動画・ゲーム・企画・出来事（発売日、アップデート、大会、話題になった出来事、コラボ相手など）の背景を確かめてから書いてください。' +
          '決まり文句（「おすすめに載った」「企画の力」だけ）は禁止。必ず、タイトルの具体的な言葉・数字（登録者・再生・比べた倍率・公開日時・長さ）・検索で分かった背景を根拠として名指しで書くこと。' +
          '分からないことは「〜と考えられる」と推測であることを明記し、誇張しないでください。すべての動画について書いてください。\n' +
          '出力はJSON配列のみ（説明文やコードブロックは不要）：[{"id":"動画ID",' +
          '"sum":"ひとことで（40文字以内）",' +
          '"entry":"入口：タイトル・サムネで何が効いているか（タイトルのどの言葉か、なぜ押したくなるか。2〜3文）",' +
          '"content":"中身・企画：何をした回で、どこが見られる理由か（2〜3文）",' +
          '"timing":"タイミング・背景：時期・流行・出来事・相手との関係など、検索で分かったこと（2〜3文。なければ空文字）",' +
          '"numbers":"数字から分かること：倍率・反応率・同じチャンネルのほかの回との差から言えること（2文）",' +
          '"copy":"小さなVTuberがまねするなら：具体的な企画・タイトルの例（1〜2文）"}]\n\n' + batch.map(line).join('\n') }], { tier: 'high', search: true });
        let n = 0;
        for (const x of Array.isArray(data) ? data : []) if (x && x.id && (x.sum || x.entry)) {
          aiBuzz[x.id] = { sum: String(x.sum || '').slice(0, 80), entry: String(x.entry || '').slice(0, 400), content: String(x.content || '').slice(0, 400),
            timing: String(x.timing || '').slice(0, 400), numbers: String(x.numbers || '').slice(0, 300), copy: String(x.copy || '').slice(0, 300) }; n++; }
        console.log(`OK   gemini buzz: ${n}/${batch.length}本をくわしく作成`);
      } catch (e) { logErr('gemini buzz', e); }
      await sleep(7000);
    }
  }

  // C-2. 話題ワードの流行理由（ジャンルごと上位20語）→ アーカイブにも保存
  //      全ジャンル分を1回の呼び出しでまとめて作る。前回説明したワードは説明を再利用して、新しいワードだけ聞く
  const oldTok = prev.aiTok || {};
  const tokTodo = [];
  for (const g of GENRES) {
    aiTok[g.id] = {};
    for (const t of (tokens[g.id] || []).slice(0, 20)) {
      if (oldTok[g.id] && oldTok[g.id][t.w]) aiTok[g.id][t.w] = oldTok[g.id][t.w];
      else tokTodo.push({ g: g.id, t });
    }
  }
  if (tokTodo.length) {
    const GJ = { all: 'すべて', game: 'ゲーム', song: '歌ってみた', talk: '雑談', plan: '企画', horror: 'ホラー' };
    const lines = tokTodo.map(({ g, t }) => `${g} | 「${t.w}」(${t.n}本, ジャンル:${GJ[g]}): ` + t.top.slice(0, 4).map(id => videos[id] && videos[id].title).filter(Boolean).join(' / ')).join('\n');
    try {
      const { data } = await gemini([{ text:
        'あなたはVTuber・YouTubeのアナリストです。次はここ1週間のVTuber動画タイトルによく出てくるワード（行頭はジャンルID）と、その代表的な動画タイトルです。' +
        '各ワードについて「何なのか」「なぜ今流行っているのか（経緯）」「VTuberがやるならどんな企画がウケそうか」を日本語で3〜4文で説明してください。分からない点は推測と明記してください。すべてのワードについて書いてください。' +
        '出力はJSON配列 [{"g":"ジャンルID","w":"ワード","reason":"説明"}] のみ。ジャンルIDとワードは入力と完全に同じ表記にしてください。\n\n' + lines }], { tier: 'high' });
      let n = 0;
      for (const x of data || []) if (x && x.g && x.w && x.reason && aiTok[x.g]) {
        aiTok[x.g][x.w] = x.reason; n++;
        const t = (tokens[x.g] || []).find(t => t.w === x.w);
        if (t && x.g !== 'all' && archive && archive[`${x.g}|${t.k}`]) archive[`${x.g}|${t.k}`].reason = x.reason;
      }
      console.log(`OK   gemini tokens: ${n}語を1回で作成`);
    } catch (e) { logErr('gemini tokens', e); }
    await sleep(7000);
  }
  // 作れなかったジャンルは前回の説明を残す
  for (const g of GENRES) if (!Object.keys(aiTok[g.id]).length && oldTok[g.id]) aiTok[g.id] = oldTok[g.id];
  }

  // C-3. ノウハウ記事：毎日2テーマ。YouTube動画＋Web記事を読んで、新しい記事を作るか、似た記事を修正する
  // focus：動画・記事から何を拾うか（カテゴリごと）
  const TOPICS = [
    { cat: 'algo',   focus: 'YouTubeのアルゴリズムで伸びるためのノウハウ', q: ['YouTube algorithm explained', 'YouTube アルゴリズム 仕組み 解説'] },
    { cat: 'talk',   focus: '配信・雑談のトーク力を鍛える具体的な方法（話題の作り方・リアクション・コメント拾い・沈黙を作らないコツなど）', q: ['how to talk on stream never run out of things to say', '配信 トーク力 鍛え方', '雑談配信 話題 コツ'] },
    { cat: 'short',  focus: 'YouTubeショートを伸ばすコツ（冒頭・尺・ループ・ネタ選び・投稿頻度など）', q: ['YouTube Shorts strategy growth', 'YouTubeショート 伸ばし方', 'YouTube Shorts hook retention tips'] },
    { cat: 'obs',    focus: 'OBS Studioの設定・使い方のコツ（画質・ビットレート・音声・シーン・プラグイン・トラブル対処など）', q: ['OBS Studio best settings for streaming YouTube', 'OBS 配信 設定 おすすめ', 'OBS 音声 ノイズ 対策 配信'] },
    { cat: 'thumb',  focus: 'サムネイルとタイトルのノウハウ', q: ['YouTube thumbnail title tips', 'YouTube サムネイル タイトル 伸ばし方'] },
    { cat: 'edit',   focus: '動画編集のコツ（カット・テンポ・テロップ・効果音・切り抜きの作り方・時短の工夫など）', q: ['video editing tips for YouTubers retention', '動画編集 コツ テンポ テロップ', '切り抜き 動画 作り方 編集'] },
    { cat: 'ai',     focus: '配信者・クリエイターのAI活用術（企画出し・台本・サムネ・字幕・切り抜き・翻訳・作業の自動化など）。権利やガイドラインの注意点も含める', q: ['how YouTubers use AI tools workflow', '配信者 AI 活用', 'AI 切り抜き 字幕 自動化 YouTuber'] },
    { cat: 'live',   focus: 'VTuber・配信者としての運用ノウハウ（配信スケジュール・コラボ・告知・リスナー維持など）', q: ['how to grow a VTuber channel', '個人VTuber 伸ばし方 配信'] },
    { cat: 'mental', focus: '配信を続けるためのメンタル・モチベーション・リスナーとの関係づくり', q: ['YouTuber burnout consistency advice', '配信者 継続 モチベーション'] },
  ];
  const CAT_JA = { algo: 'アルゴリズム攻略', talk: 'トーク力', short: 'ショート動画のコツ', obs: 'OBS・配信設定', thumb: 'サムネイル・タイトル術', edit: '動画編集のコツ', ai: 'AI活用術', live: '配信・VTuber運用', mental: 'メンタル・リスナー維持' };
  const usedSrc = new Set(notes.flatMap(n => (n.sources || []).map(s => s.url)));
  // 通常は毎日2本（i=0,1）。CH_ONLY（残りの枠を使う更新）では別のテーマで3本追加（i=2,3,4）
  const NOTE_FROM = CH_ONLY ? 2 : 0, NOTE_N = CH_ONLY ? 3 : 2;
  for (let i = NOTE_FROM; i < NOTE_FROM + NOTE_N; i++) {
    const topic = TOPICS[(dayNo * 2 + i) % TOPICS.length];
    const q = topic.q[(dayNo + i) % topic.q.length];
    const sources = [];
    let videoSum = null, webPts = null;
    // (a) YouTube 動画
    try {
      const s = await yt('search', { part: 'snippet', type: 'video', q, maxResults: 10, videoDuration: 'medium', order: 'relevance', publishedAfter: after(730) }, 100);
      const it = (s.items || []).find(it => it.id && it.id.videoId && !usedSrc.has(`https://www.youtube.com/watch?v=${it.id.videoId}`));
      if (it) {
        const url = `https://www.youtube.com/watch?v=${it.id.videoId}`;
        const { data } = await gemini([{ file_data: { file_uri: url } }, { text:
          `この動画で話されている「${topic.focus}」を日本語で要約してください。` + '出力はJSONのみ: {"points":[{"h":"見出し","p":"説明（2〜3文）"}]}。points は4〜6個。動画で実際に話されている内容だけを書いてください。' }]);
        if (data && data.points) { videoSum = data.points; sources.push({ type: 'video', id: it.id.videoId, url, title: it.snippet.title, by: it.snippet.channelTitle }); usedSrc.add(url); }
      }
    } catch (e) { logErr(`gemini note video ${topic.cat}`, e); }
    await sleep(7000);
    // (b) Web記事（Google検索で調べる）
    try {
      const { data, chunks } = await gemini([{ text:
        `「${q}」について、Web上の記事（ブログ・解説記事・公式ヘルプなど）を検索して、${topic.focus}を具体的に調べてください。` +
        '出力はJSONのみ: {"points":[{"h":"見出し","p":"説明（2〜3文）"}]}。points は3〜5個。記事に書かれている内容だけを書いてください。' }], { search: true });
      if (data && data.points) {
        webPts = data.points;
        for (const c of chunks.slice(0, 4)) if (c.uri && !usedSrc.has(c.uri)) { sources.push({ type: 'article', url: c.uri, title: c.title || 'Web記事', by: c.title || '' }); usedSrc.add(c.uri); }
      }
    } catch (e) { logErr(`gemini note web ${topic.cat}`, e); }
    await sleep(7000);
    if (!videoSum && !webPts) continue;
    // (c) 既存の記事と照らし合わせて「新規」か「修正」かを決めて書く
    try {
      const list = notes.slice(0, 80).map(n => `${n.id} | ${CAT_JA[n.cat] || n.cat} | ${n.title} | ${(n.summary || [])[0] || ''}`).join('\n') || '（まだ記事はありません）';
      const { data } = await gemini([{ text:
        'あなたはVTuber・配信者向けにノウハウ記事を書く編集者です。次の「新しい資料」を読み、既存の記事一覧と比べてください。\n' +
        '・内容がほぼ同じテーマの記事があれば action="update" にして target にその記事IDを入れ、新しい資料の内容を取り込んで記事全体を書き直してください。change には何を修正・追記したかを1〜2文で書いてください。\n' +
        '・新しいテーマなら action="new" にしてください。\n' +
        '記事は日本語で、VTuber・配信者がすぐ使える具体的な内容にしてください。資料にないことを断定しないでください。\n' +
        '出力はJSONのみ: {"action":"new|update","target":"記事ID または 空","title":"記事タイトル","summary":["3行要約1","2","3"],"sections":[{"h":"見出し","p":"本文（3〜5文）"}],"forVtuber":["すぐできること"],"change":"修正内容"}\n' +
        `sections は3〜6個、forVtuber は2〜4個。テーマのカテゴリ: ${CAT_JA[topic.cat]}（${topic.focus}）。修正する場合も、同じカテゴリの記事だけを対象にしてください。\n\n` +
        `【既存の記事一覧】\n${list}\n\n【新しい資料：動画の要約】\n${JSON.stringify(videoSum || [])}\n\n【新しい資料：Web記事の要約】\n${JSON.stringify(webPts || [])}` }], { tier: 'high' });
      if (!data || !data.title) throw new Error('記事の生成結果が空');
      const target = data.action === 'update' && notes.find(n => n.id === data.target);
      if (target) {
        Object.assign(target, { title: data.title, summary: data.summary || target.summary, sections: data.sections || target.sections, forVtuber: data.forVtuber || target.forVtuber, updated: day });
        target.sources = [...(target.sources || []), ...sources.map(s => ({ ...s, added: day }))];
        target.history = [...(target.history || []), { d: day, note: data.change || '新しい資料をもとに内容を更新しました', add: sources.map(s => s.title) }];
        console.log(`OK   note 修正 ${target.id}: ${data.title}`);
      } else {
        const id = 'n' + day.replace(/-/g, '') + i;
        notes.unshift({ id, cat: topic.cat, title: data.title, summary: data.summary || [], sections: data.sections || [], forVtuber: data.forVtuber || [],
          sources: sources.map(s => ({ ...s, added: day })), history: [{ d: day, note: '新しく作成しました', add: sources.map(s => s.title) }], created: day, updated: day });
        console.log(`OK   note 新規 ${id}: ${data.title}`);
      }
    } catch (e) { logErr(`gemini note write ${topic.cat}`, e); }
    await sleep(7000);
  }
  notes = notes.slice(0, 400);

  // C-5. メンバーの配信を映像で分析（マイチャンネルの「コンテンツ別」に出す）
  await memberSteps();

  // C-4. AIトレンド分析：全データを読んで「今の流行」「これから流行りそうなもの」「VTuberへのおすすめ」をまとめる
  //      いちばん大事なので、AIの処理の最初に実行する（runInsight を C の先頭で呼ぶ）
  async function runInsight() { if (CH_ONLY) return; try {
    const GJ = { all:'すべて', game:'ゲーム', song:'歌ってみた', talk:'雑談', plan:'企画', horror:'ホラー' };
    const lines = [];
    for (const g of GENRES) {
      const ts = (tokens[g.id] || []).filter(t => (t.nch || 1) >= 2).slice(0, 15);
      if (ts.length) lines.push(`【話題ワード：${GJ[g.id]}】` + ts.map(t => `${t.w}(${t.n}本/${t.nch || '?'}ch/${{ new:'新登場', up:'急上昇', steady:'継続', down:'落ち着き' }[t.st] || ''})`).join('、'));
    }
    const allIds = new Set();
    for (const g of GENRES) for (const f of FORMATS) for (const p of ['7', 'new']) (pools[`${g.id}|${f.id}|${p}`] || []).forEach(id => allIds.add(id));
    const vs = [...allIds].map(id => videos[id]).filter(v => v && v.subs && v.views >= 5000 && !isClip(v));
    const buzz = vs.slice().sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, 20);
    lines.push('【登録者に対して伸びた動画】\n' + buzz.map(v => `・${v.title}（${v.ch}・登録者${v.subs}・${v.views}回・${v.stream ? '配信' : fmtOf(v) === 'short' ? 'ショート' : '動画'}）`).join('\n'));
    const st = {}; vs.forEach(v => styleOf(v.title).forEach(s => st[s] = (st[s] || 0) + 1));
    lines.push('【企画スタイルの件数】' + Object.entries(st).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}${n}`).join('、'));
    const fm = { video: 0, stream: 0, short: 0 }; vs.forEach(v => fm[fmtOf(v)]++);
    lines.push(`【形式の内訳】動画${fm.video}・配信${fm.stream}・ショート${fm.short}`);
    if (steam && steam.soon && steam.apps) lines.push('【Steam 注目の発売予定ゲーム】' + (steam.soon.all || []).slice(0, 12).map(id => steam.apps[id] && `${steam.apps[id].name}(${steam.apps[id].date})`).filter(Boolean).join('、'));
    if (steam && steam.soon && steam.apps) lines.push('【Steam 発売予定ホラー】' + (steam.soon.horror || []).slice(0, 8).map(id => steam.apps[id] && `${steam.apps[id].name}(${steam.apps[id].date})`).filter(Boolean).join('、'));
    const rising = Object.values(archive || {}).filter(a => a.st === 'up' || a.st === 'new').sort((a, b) => (b.peak || 0) - (a.peak || 0)).slice(0, 15);
    if (rising.length) lines.push('【最近増えている流行】' + rising.map(a => `${a.w}(${GJ[a.g]}・最大${a.peak}本/週)`).join('、'));
    if (gtrends && gtrends.length) lines.push('【Google急上昇（日本全体）】' + gtrends.slice(0, 15).map(t => t.w).join('、'));

    // 登録者1万人未満のチャンネルの実データ（アルゴリズム・戦略の根拠）
    const small = [...allIds].map(id => videos[id]).filter(v => v && v.subs && v.subs < 10000 && !isClip(v));
    const med = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
    const stats = [];
    if (small.length >= 20) {
      const byF = { video: [], stream: [], short: [] }; small.forEach(v => byF[fmtOf(v)].push(ratioOf(v)));
      const fj = { video: '動画', stream: '配信', short: 'ショート' };
      lines.push(`【登録者1万人未満のチャンネル：${small.length}本】`);
      lines.push('形式別の伸び率（再生÷登録者）の中央値：' + Object.entries(byF).map(([f, a]) => `${fj[f]} ×${med(a).toFixed(2)}（${a.length}本）`).join('、'));
      Object.entries(byF).forEach(([f, a]) => a.length && stats.push({ label: `${fj[f]}の伸び率`, value: `×${med(a).toFixed(2)}` }));
      const top = small.slice().sort((a, b) => ratioOf(b) - ratioOf(a)).slice(0, Math.max(10, Math.round(small.length * 0.2)));
      const stS = {}, stT = {};
      small.forEach(v => styleOf(v.title).forEach(s => (stS[s] = stS[s] || []).push(ratioOf(v))));
      top.forEach(v => styleOf(v.title).forEach(s => stT[s] = (stT[s] || 0) + 1));
      lines.push('企画スタイル別の伸び率の中央値：' + Object.entries(stS).filter(([, a]) => a.length >= 3).map(([s, a]) => [s, med(a), a.length]).sort((a, b) => b[1] - a[1]).map(([s, m, n]) => `${s} ×${m.toFixed(2)}（${n}本）`).join('、'));
      const hours = {}; top.forEach(v => { const h = new Date(Date.parse(v.published) + 9 * 3600e3).getUTCHours(); const b = h < 6 ? '深夜0-6時' : h < 12 ? '朝6-12時' : h < 18 ? '昼12-18時' : '夜18-24時'; hours[b] = (hours[b] || 0) + 1; });
      lines.push('よく伸びた上位2割の動画の投稿時間帯（日本時間）：' + Object.entries(hours).sort((a, b) => b[1] - a[1]).map(([b, n]) => `${b} ${n}本`).join('、'));
      const topH = Object.entries(hours).sort((a, b) => b[1] - a[1])[0]; if (topH) stats.push({ label: '伸びた動画が多い時間帯', value: topH[0] });
      const br = a => a.length ? Math.round(a.filter(v => /【[^】]+】/.test(v.title)).length / a.length * 100) : 0;
      const tl = a => a.length ? Math.round(a.reduce((s, v) => s + [...v.title].length, 0) / a.length) : 0;
      const ht = a => a.length ? (a.reduce((s, v) => s + (v.title.match(/#/g) || []).length, 0) / a.length).toFixed(1) : 0;
      lines.push(`タイトル：上位2割は【】使用率${br(top)}%・平均${tl(top)}文字・#タグ平均${ht(top)}個／全体は【】使用率${br(small)}%・平均${tl(small)}文字・#タグ平均${ht(small)}個`);
      stats.push({ label: '伸びた動画の【】使用率', value: `${br(top)}%` });
      const tw = {}; top.forEach(v => (v.title.match(/【([^】]+)】/g) || []).forEach(m => { const w = m.slice(1, -1).split(/[\/|・]/)[0].trim(); if (w.length >= 2) tw[w] = (tw[w] || 0) + 1; }));
      lines.push('小規模チャンネルで伸びた動画の【】の中身：' + Object.entries(tw).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([w, n]) => `${w}(${n})`).join('、'));
      lines.push('小規模チャンネルで特に伸びた動画：\n' + top.slice(0, 12).map(v => `・${v.title}（登録者${v.subs}・${v.views}回・${fmtOf(v) === 'stream' ? '配信' : fmtOf(v) === 'short' ? 'ショート' : '動画'}）`).join('\n'));
    }
    await sleep(5000);
    const { data } = await gemini([{ text:
      'あなたは日本のVTuber業界とYouTubeのアルゴリズムに詳しいトレンドアナリスト兼チャンネル戦略コンサルタントです。\n' +
      '読者は「所属タレント全員が登録者1万人未満の小規模VTuber事務所」のタレントと運営です。大手向けではなく、登録者0〜1万人のVTuberが実行できる内容にしてください。\n' +
      '次は直近1週間の日本のVTuber動画（YouTube）を集計したデータです。データから言えること・推測を区別し、推測は「〜と考えられる」と書いてください。具体的なゲーム名・企画名・数字を使ってください。\n' +
      '出力はJSONのみ: {"summary":"今のVTuberの流行のまとめ（3〜4文）",' +
      '"now":[{"title":"今流行っているもの","detail":"何がどう流行っているか（2〜3文）"}],' +
      '"next":[{"title":"これから流行りそうなもの","why":"そう考える理由（データの根拠）","how":"登録者1万人未満のVTuberがやるならどんな企画にするか"}],' +
      '"strategy":[{"title":"YouTubeのアルゴリズム・戦略のポイント","detail":"登録者1万人未満のチャンネルの実データ（形式別の伸び率・企画スタイル・投稿時間帯・タイトル）を根拠にした説明（2〜3文）","actions":["具体的にやること1","やること2"]}],' +
      '"recommend":[{"target":"対象（例：登録者〜1,000人の新人／1,000〜5,000人／5,000〜1万人／歌が得意な人 など）","title":"おすすめの活動","steps":["具体的な手順1","手順2","手順3"]}],' +
      '"caution":["注意点（権利・ガイドライン・流行の終わりかけ等）"]}\n' +
      'now は5個、next は5個、strategy は4〜5個（ショートと配信の使い分け、タイトル・サムネ、投稿時間・頻度、流行ワードの乗り方、登録者を増やす導線 など）、recommend は4個（すべて登録者1万人未満向け）、caution は2〜3個。\n\n' + lines.join('\n') }], { tier: 'high' });
    if (!data || !data.summary) throw new Error('分析結果が空');
    insight = { ...data, stats, d: day, model: MODEL };
    console.log('OK   AIトレンド分析');
  } catch (e) { logErr('gemini insight', e); } }
} else {
  console.log('GEMINI_API_KEY なし：AIによる理由・記事はスキップ（画面ではルールベースの理由を表示）');
}

// ---------------------------------------------------------------------
const out = {
  updated: AI_ONLY ? prev.updated : new Date(now).toISOString(), units, ai: !!GEM, diag,
  pools, videos, histDays, subs, tokens, tokens2, tokHist, archive,
  suggest: suggestOut, gtrends, aiBuzz, aiTok, notes, steam, classic, chans, chv, chtop,
  // メンバーの配信の映像分析（マイチャンネル用）
  my: myDeep, mypub: myPub,
  // AIの精査結果（今のデータに出てくる動画の分だけ残す）
  aiv: Object.fromEntries(Object.entries(aiv).filter(([id]) => videos[id])),
  // AIトレンド分析（最新＋過去14日分）
  insights: insight ? [insight, ...(prev.insights || []).filter(x => x.d !== insight.d)].slice(0, 14) : (prev.insights || []),
};
await writeFile(OUT, JSON.stringify(out));
console.log(`完了: 動画${Object.keys(videos).length}本 / 使用ユニット 約${units}${GEM ? ` / AIモデル ${MODEL}` : ''} / エラー ${diag.errors.length}件`);
