// Cloudflare Worker for the tennis bracket app.
//  - POST /        : commits the submitted results text to results/<date>.txt
//  - GET  /stats    : reads every results/*.txt file and renders an awards
//                      report (출석왕/승률왕/케미 등) plus the rankings table
//  - GET  /state    : returns the shared roster/schedule state (from KV) so
//                      every browser (KakaoTalk in-app, Safari, ...) sees the
//                      same edits instead of each keeping its own localStorage
//  - POST /state    : overwrites the shared state (last write wins)
// The GitHub token stays in the Worker's secret store — it is never sent to
// or readable from the public page.

const OWNER = 'unipro8787';
const REPO = 'tennis-bracket';
const ALLOWED_ORIGIN = 'https://unipro8787.github.io';

// eligibility / sample-size floors for the awards below
// 통계·수상 대상 회원 (단톡방 명단 기준, 2026-11-18)
const MEMBERS = new Set([
  '안유현', '우대원', '권수기', '남택원', '김종해', '이병일', '류병기',
  '서승훈', '신동휘', '이희영', '최영열', '최종근', '허영주',
]);

const MIN_TOTAL_GAMES = 10; // "최소 10경기 이상 참여한 회원"
const MIN_PAIR_GAMES = 5;   // 베스트/워스트 케미: 함께 뛴 경기 수
const MIN_CLOSE_GAMES = 5;  // 강철 멘탈: 접전 경기 표본
const MIN_HALF_GAMES = 5;   // 폭풍 성장상: 상/하반기 각각 표본
const MIN_H2H_GAMES = 5;    // 천적 관계: 맞대결 표본

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'tennis-bracket-results-worker',
  };
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---- save results (existing behavior) ----

async function handleSaveResults(request, env, origin) {
  const headers = corsHeaders(origin);
  if (origin !== ALLOWED_ORIGIN) {
    return new Response('Forbidden origin', { status: 403, headers });
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Invalid JSON', { status: 400, headers });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text || text.length > 20000) {
    return new Response('Invalid text', { status: 400, headers });
  }

  const today = new Date().toISOString().slice(0, 10);
  const path = `results/${today}.txt`;
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;

  let sha;
  const getResp = await fetch(apiUrl, { headers: ghHeaders(env) });
  if (getResp.status === 200) {
    sha = (await getResp.json()).sha;
  } else if (getResp.status !== 404) {
    return new Response(`GitHub lookup error: ${await getResp.text()}`, { status: 502, headers });
  }

  const putResp = await fetch(apiUrl, {
    method: 'PUT',
    headers: ghHeaders(env),
    body: JSON.stringify({
      message: `결과 저장 ${today}`,
      content: utf8ToBase64(text),
      ...(sha ? { sha } : {}),
    }),
  });

  if (!putResp.ok) {
    return new Response(`GitHub commit error: ${await putResp.text()}`, { status: 502, headers });
  }
  return new Response('OK', { status: 200, headers });
}

// ---- shared state (roster/schedule/scores) sync across browsers/devices ----

const STATE_KV_KEY = 'current';

async function handleGetState(env, origin) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' };
  const raw = await env.STATE.get(STATE_KV_KEY);
  return new Response(raw || 'null', { status: 200, headers });
}

async function handleSaveState(request, env, origin) {
  const headers = corsHeaders(origin);
  if (origin !== ALLOWED_ORIGIN) {
    return new Response('Forbidden origin', { status: 403, headers });
  }
  const text = await request.text();
  if (!text || text.length > 200000) {
    return new Response('Invalid state', { status: 400, headers });
  }
  try {
    JSON.parse(text);
  } catch (e) {
    return new Response('Invalid JSON', { status: 400, headers });
  }
  await env.STATE.put(STATE_KV_KEY, text);
  return new Response('OK', { status: 200, headers });
}

// ---- parsing ----

// mirrors the line format written by buildResultsText() in index.html:
//   휴식: A, B, C
//   [코트 1] P1 · P2 vs P3 · P4 → 승: P1 · P2 (6:4)
// the trailing "(a:b)" is always teamA's score : teamB's score, regardless
// of who won or whether it was a draw.
function parseResultsFile(text) {
  const events = [];
  const rests = [];
  const attendees = new Set(); // 그날 나온 사람 전원 (휴식·미정 경기 포함) — 개근상용
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const restMatch = line.match(/^휴식:\s*(.+)$/);
    if (restMatch) {
      restMatch[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => { rests.push(n); attendees.add(n); });
      continue;
    }
    const m = line.match(/^\[코트\s*\d+\]\s*(.+?)\s+vs\s+(.+?)\s*→\s*승:\s*(.+)$/);
    if (!m) continue;
    const teamAStr = m[1].trim();
    const teamBStr = m[2].trim();
    const outcome = m[3].trim();
    const teamA = teamAStr.split('·').map(s => s.trim()).filter(Boolean);
    const teamB = teamBStr.split('·').map(s => s.trim()).filter(Boolean);
    [...teamA, ...teamB].forEach(n => attendees.add(n));
    if (teamA.length !== 2 || teamB.length !== 2) continue;

    let winner = null;
    if (outcome.startsWith('무승부')) winner = 'draw';
    else if (outcome.startsWith(teamAStr)) winner = 'A';
    else if (outcome.startsWith(teamBStr)) winner = 'B';
    if (winner === null) continue; // "미정" (score not entered) — excluded from stats

    const scoreMatch = outcome.match(/\((\d+):(\d+)\)\s*$/);
    const scoreA = scoreMatch ? Number(scoreMatch[1]) : null;
    const scoreB = scoreMatch ? Number(scoreMatch[2]) : null;

    events.push({ teamA, teamB, winner, scoreA, scoreB });
  }
  return { events, rests, attendees };
}

function ensurePlayer(stats, name) {
  if (!stats.has(name)) {
    stats.set(name, {
      name, games: 0, wins: 0, losses: 0, draws: 0, rests: 0, days: 0, pointDiff: 0,
      closeGames: 0, closeWins: 0,
      h1Games: 0, h1Wins: 0, h2Games: 0, h2Wins: 0,
    });
  }
  return stats.get(name);
}

function half(dateStr) {
  const month = Number(dateStr.slice(5, 7));
  return month >= 1 && month <= 6 ? 1 : 2;
}

function pairKey(a, b) {
  return [a, b].sort().join(' & ');
}

// aggregates per-player, per-teammate-pair, and head-to-head opponent stats
// across every saved results file. `files` is [{ date, content }].
function buildAggregates(files) {
  const stats = new Map();
  const pairStats = new Map();
  const h2h = new Map(); // key `${x}→${y}`: how often x beat y as opponents

  function h2hEntry(x, y) {
    const key = `${x}→${y}`;
    if (!h2h.has(key)) h2h.set(key, { x, y, games: 0, wins: 0 });
    return h2h.get(key);
  }

  files.forEach(({ date, content }) => {
    const { events, rests, attendees } = parseResultsFile(content);
    rests.forEach(n => { ensurePlayer(stats, n).rests++; });
    attendees.forEach(n => { ensurePlayer(stats, n).days++; });
    const h = date ? half(date) : null;

    events.forEach(({ teamA, teamB, winner, scoreA, scoreB }) => {
      const all = [...teamA, ...teamB];

      all.forEach(n => { ensurePlayer(stats, n).games++; });
      if (scoreA !== null && scoreB !== null) {
        teamA.forEach(n => { ensurePlayer(stats, n).pointDiff += scoreA - scoreB; });
        teamB.forEach(n => { ensurePlayer(stats, n).pointDiff += scoreB - scoreA; });
      }

      [teamA, teamB].forEach(([p1, p2]) => {
        const key = pairKey(p1, p2);
        if (!pairStats.has(key)) pairStats.set(key, { players: [p1, p2].sort(), games: 0, wins: 0 });
        pairStats.get(key).games++;
      });

      if (h === 1) all.forEach(n => { ensurePlayer(stats, n).h1Games++; });
      else if (h === 2) all.forEach(n => { ensurePlayer(stats, n).h2Games++; });

      const isClose = scoreA !== null && scoreB !== null && Math.abs(scoreA - scoreB) <= 1;
      if (isClose) all.forEach(n => { ensurePlayer(stats, n).closeGames++; });

      teamA.forEach(x => teamB.forEach(y => {
        h2hEntry(x, y).games++;
        h2hEntry(y, x).games++;
      }));

      if (winner === 'draw') {
        all.forEach(n => { ensurePlayer(stats, n).draws++; });
        return;
      }

      const winTeam = winner === 'A' ? teamA : teamB;
      const loseTeam = winner === 'A' ? teamB : teamA;

      winTeam.forEach(n => {
        const p = ensurePlayer(stats, n);
        p.wins++;
        if (h === 1) p.h1Wins++;
        else if (h === 2) p.h2Wins++;
        if (isClose) p.closeWins++;
      });
      loseTeam.forEach(n => { ensurePlayer(stats, n).losses++; });
      pairStats.get(pairKey(winTeam[0], winTeam[1])).wins++;

      winTeam.forEach(x => loseTeam.forEach(y => { h2hEntry(x, y).wins++; }));
    });
  });

  return { players: [...stats.values()], pairs: [...pairStats.values()], h2h: [...h2h.values()] };
}

function decided(p) {
  return p.wins + p.losses + p.draws;
}

function rate(wins, games) {
  return games > 0 ? wins / games : null;
}

function pct(r, digits = 0) {
  return r === null ? '—' : `${(r * 100).toFixed(digits)}%`;
}

// ---- awards ----

// best-first 정렬 기준 cmp로 1등과 비기는(cmp === 0) 후보를 모두 돌려준다 → 공동 수상
function topTies(items, cmp) {
  if (!items.length) return [];
  const sorted = [...items].sort(cmp);
  return sorted.filter(x => cmp(x, sorted[0]) === 0);
}

function computeAwards(players, pairs, h2h, totalDates) {
  const eligible = players.filter(p => p.games >= MIN_TOTAL_GAMES);
  const eligibleNames = new Set(eligible.map(p => p.name));

  // 개근상: 출석한 날짜 수가 가장 많은 회원 (경기 수 기준 아님, 공동 수상)
  const perfectAttendance = topTies(players.filter(p => p.days > 0), (a, b) => b.days - a.days);

  const attendance = [...eligible].sort((a, b) => b.games - a.games).slice(0, 3);

  const winRateTop = eligible
    .map(p => ({ p, rate: rate(p.wins, decided(p)) }))
    .filter(x => x.rate !== null)
    .sort((a, b) => b.rate - a.rate || b.p.wins - a.p.wins)
    .slice(0, 3);

  // MVP: 전체 날짜의 절반 이상 나온 회원 중 승률 1위, 같으면 득실차
  const mvpMinDays = Math.ceil(totalDates / 2);
  const mvp = topTies(
    eligible.filter(p => p.days >= mvpMinDays).map(p => ({ p, rate: rate(p.wins, decided(p)) })).filter(x => x.rate !== null),
    (a, b) => (b.rate - a.rate) || (b.p.pointDiff - a.p.pointDiff),
  );

  // 같은 승률이면 함께 뛴 경기가 많은 쪽(근거가 많은 쪽)이 앞선다. 승률·경기 수가 같으면 공동
  const pairCandidates = pairs
    .filter(pr => pr.games >= MIN_PAIR_GAMES && eligibleNames.has(pr.players[0]) && eligibleNames.has(pr.players[1]))
    .map(pr => ({ ...pr, rate: rate(pr.wins, pr.games) }));
  const bestPair = topTies(pairCandidates, (a, b) => (b.rate - a.rate) || (b.games - a.games));
  const worstPair = topTies(pairCandidates, (a, b) => (a.rate - b.rate) || (b.games - a.games));

  const closeMental = topTies(
    eligible.map(p => ({ p, games: p.closeGames, rate: rate(p.closeWins, p.closeGames) })).filter(x => x.games >= MIN_CLOSE_GAMES),
    (a, b) => (b.rate - a.rate) || (b.games - a.games),
  );

  const mip = topTies(
    eligible
      .map(p => {
        const r1 = rate(p.h1Wins, p.h1Games);
        const r2 = rate(p.h2Wins, p.h2Games);
        const delta = (r1 !== null && r2 !== null) ? r2 - r1 : null;
        return { p, r1, r2, delta };
      })
      .filter(x => x.delta !== null && x.p.h1Games >= MIN_HALF_GAMES && x.p.h2Games >= MIN_HALF_GAMES),
    (a, b) => b.delta - a.delta,
  );

  const nemesis = topTies(
    h2h.filter(e => e.games >= MIN_H2H_GAMES && eligibleNames.has(e.x) && eligibleNames.has(e.y))
      .map(e => ({ ...e, rate: rate(e.wins, e.games) })),
    (a, b) => (b.rate - a.rate) || (b.games - a.games),
  );

  return { totalDates, mvpMinDays, perfectAttendance, mvp, attendance, winRateTop, bestPair, worstPair, closeMental, mip, nemesis };
}

const MEDALS = ['🥇', '🥈', '🥉'];
const signed = n => (n > 0 ? `+${n}` : `${n}`);

// 상 하나의 정의: 수상자 줄(텍스트) 목록, 소개 문구, 비었을 때 문구.
// 마크다운과 HTML 카드가 같은 정의를 쓴다.
function awardSections(a) {
  const co = list => (list.length > 1 ? ' (공동)' : '');
  const pairLine = x => [`${x.players[0]} & ${x.players[1]}`, `${x.games}전 ${x.wins}승 (승률 ${pct(x.rate)})`];
  return [
    { emoji: '🏅', title: `개근상${co(a.perfectAttendance)}`,
      rows: a.perfectAttendance.map(p => [p.name, `${a.totalDates}회 중 ${p.days}회 출석`]),
      quote: '비가 오나 눈이 오나 코트에 있던 분 🏅', empty: '집계할 데이터가 부족해요.' },
    { emoji: '👑', title: `MVP${co(a.mvp)}`,
      rows: a.mvp.map(x => [x.p.name, `승률 ${pct(x.rate)} (${x.p.wins}승 ${x.p.losses}패 ${x.p.draws}무) · 득실 ${signed(x.p.pointDiff)}`]),
      quote: '올 시즌 코트의 주인공 👑', empty: `${a.mvpMinDays}회 이상 출석한 회원이 아직 없어요.`,
      note: `${a.mvpMinDays}회 이상 출석한 회원 중 승률 1위, 같으면 득실차` },
    { emoji: '🏟️', title: '코트의 지주 (출석왕)', medals: true,
      rows: a.attendance.map(p => [p.name, `${p.games}경기`]),
      quote: '코트가 곧 안방인 분들 🏠', empty: `최소 ${MIN_TOTAL_GAMES}경기를 채운 회원이 아직 없어요.` },
    { emoji: '🏆', title: '승리 보증수표 (승률왕)', medals: true,
      rows: a.winRateTop.map(x => [x.p.name, `${pct(x.rate)} (${x.p.wins}승 ${x.p.losses}패 ${x.p.draws}무)`]),
      quote: '이 이름이 상대편에 보이면 오늘 코트는 접어야 합니다 😮‍💨', empty: '집계할 데이터가 부족해요.' },
    { emoji: '🤝', title: `환상의 짝꿍 (베스트 케미)${co(a.bestPair)}`, rows: a.bestPair.map(pairLine),
      quote: '이 조합이 뜨면 상대팀 표정부터 굳는다 🤝', empty: `함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요.` },
    { emoji: '💔', title: `비운의 짝꿍 (워스트 케미)${co(a.worstPair)}`, rows: a.worstPair.map(pairLine),
      quote: '친하긴 한데... 코트에서만은 따로 다니는 게 나을지도? 💔', empty: `함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요.` },
    { emoji: '🧠', title: `강철 멘탈 (접전 강자)${co(a.closeMental)}`,
      rows: a.closeMental.map(x => [x.p.name, `접전(1점 차 이내) ${x.games}전 승률 ${pct(x.rate)}`]),
      quote: '듀스만 가면 눈빛이 달라지는 사람 🧠', empty: `접전 경기 표본(${MIN_CLOSE_GAMES}경기 이상)이 부족해요.` },
    { emoji: '📈', title: `폭풍 성장상 (MIP)${co(a.mip)}`,
      rows: a.mip.map(x => [x.p.name, `상반기 ${pct(x.r1)} → 하반기 ${pct(x.r2)} (+${pct(x.delta)}p)`]),
      quote: '상반기의 그 사람이 아닙니다 📈', empty: `상/하반기 각각 ${MIN_HALF_GAMES}경기 이상 뛴 회원이 아직 없어요.` },
    { emoji: '🏹', title: `천적 관계${co(a.nemesis)}`,
      rows: a.nemesis.map(e => [`${e.x} ▶ ${e.y}`, `${e.games}전 ${e.wins}승 (승률 ${pct(e.rate)})`]),
      quote: a.nemesis.length === 1 ? `${a.nemesis[0].y}님, ${a.nemesis[0].x}님만 만나면 유독 안 풀리시더라구요 🏹` : '만나기만 하면 승부가 기우는 상대들 🏹',
      empty: `같은 상대와 ${MIN_H2H_GAMES}번 이상 맞붙은 기록이 아직 없어요.` },
  ];
}

function renderAwardsMarkdown(awards) {
  const L = ['## 🎾 테니스 동호회 어워드 🎾', ''];
  awardSections(awards).forEach(s => {
    L.push(`### ${s.emoji} ${s.title}`);
    if (!s.rows.length) {
      L.push(`_${s.empty}_`);
    } else {
      s.rows.forEach(([who, detail], i) => L.push(`${s.medals ? (MEDALS[i] || `${i + 1}.`) : '-'} **${who}** — ${detail}`));
      if (s.note) L.push(`_(${s.note})_`);
      L.push(`> "${s.quote}"`);
    }
    L.push('');
  });
  L.push(`_(개근상 외에는 최소 ${MIN_TOTAL_GAMES}경기 이상 참여한 회원 기준)_`);
  return L.join('\n');
}

function renderAwardsCardsHtml(awards) {
  const cards = awardSections(awards).map(s => {
    let body = '';
    if (s.rows.length) {
      body = s.medals
        ? `<ol class="medal-list">${s.rows.map(([who, detail], i) => `<li><span class="medal">${MEDALS[i] || i + 1}</span> ${escapeHtml(who)} <span class="stat">${escapeHtml(detail)}</span></li>`).join('')}</ol>`
        : s.rows.map(([who, detail]) => `<p class="big"><strong>${escapeHtml(who)}</strong></p><p class="stat">${escapeHtml(detail)}</p>`).join('');
      if (s.note) body += `<p class="stat note">${escapeHtml(s.note)}</p>`;
    }
    return `<div class="award-card">
      <h3>${s.emoji} ${escapeHtml(s.title)}</h3>
      ${body || `<p class="empty">${escapeHtml(s.empty)}</p>`}
      ${body ? `<p class="quote">${escapeHtml(s.quote)}</p>` : ''}
    </div>`;
  }).join('');
  return `<div class="award-grid">${cards}</div>
  <p class="sub">(개근상 외에는 최소 ${MIN_TOTAL_GAMES}경기 이상 참여한 회원 기준)</p>`;
}

function renderRankingTablesHtml(players) {
  const ranked = players
    .filter(p => p.games > 0)
    .sort((a, b) => {
      const decidedA = decided(a);
      const decidedB = decided(b);
      const ra = rate(a.wins, decidedA) ?? -1;
      const rb = rate(b.wins, decidedB) ?? -1;
      if (rb !== ra) return rb - ra;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.games - a.games;
    });

  if (ranked.length === 0) return '<p class="empty">집계할 경기 결과가 없습니다.</p>';

  const rankRows = ranked.map((p, i) => `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${p.games}</td>
      <td>${p.wins}</td>
      <td>${p.losses}</td>
      <td>${p.draws}</td>
      <td>${pct(rate(p.wins, decided(p)))}</td>
      <td>${p.rests}</td>
    </tr>`).join('');

  return `
  <h2>순위</h2>
  <div class="table-scroll"><table>
    <thead><tr><th>순위</th><th>이름</th><th>경기</th><th>승</th><th>패</th><th>무</th><th>승률</th><th>휴식</th></tr></thead>
    <tbody>${rankRows}</tbody>
  </table></div>`;
}

function renderStatsHtml(players, awards, markdown) {
  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>테니스 복식조 통계 · 어워드</title>
<style>
  body { font-family: "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; background:#f2f6f1; color:#17241c; margin:0; padding:24px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  h2 { font-size:1.05rem; margin:24px 0 10px; }
  p.sub { color:#5f6f66; margin:0 0 24px; font-size:0.88rem; max-width:60ch; }
  table { border-collapse:collapse; width:100%; margin-bottom:32px; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #dde4da; font-size:0.9rem; white-space:nowrap; }
  th { background:#e4f1e9; color:#145c39; font-size:0.78rem; }
  .empty { color:#5f6f66; padding:20px 0; }
  .table-scroll { overflow-x:auto; }

  .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin:0 0 20px; }
  .btn { display:inline-flex; align-items:center; gap:6px; border:none; border-radius:8px; padding:9px 14px; font-size:0.85rem; font-weight:600; cursor:pointer; text-decoration:none; }
  .btn-accent { background:#145c39; color:#fff; }
  #copy-status { font-size:0.82rem; color:#145c39; align-self:center; }

  .award-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px,1fr)); gap:14px; margin-bottom:8px; }
  .award-card { background:#fff; border-radius:12px; padding:16px; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
  .award-card h3 { margin:0 0 10px; font-size:0.95rem; }
  .award-card .big { margin:4px 0 2px; font-size:1.02rem; }
  .award-card .stat { margin:0 0 4px; color:#3a473f; font-size:0.85rem; }
  .award-card .note { color:#5f6f66; font-size:0.78rem; }
  .award-card .quote { margin:10px 0 0; font-size:0.8rem; color:#5f6f66; font-style:italic; }
  .award-card .empty { padding:0; font-size:0.85rem; }
  .medal-list { list-style:none; margin:0; padding:0; }
  .medal-list li { display:flex; align-items:baseline; gap:8px; padding:3px 0; font-size:0.9rem; }
  .medal-list .medal { font-size:1rem; width:1.4em; }
  .medal-list .stat { margin-left:auto; color:#5f6f66; font-size:0.82rem; }

</style></head>
<body>
  <h1>🎾 테니스 복식조 통계 · 어워드</h1>
  <p class="sub">저장된 모든 결과 파일(results/*.txt)을 집계했습니다. 점수를 입력하지 않은 "미정" 경기는 제외됩니다.</p>

  <div class="toolbar">
    <button type="button" class="btn btn-accent" onclick="copyShareText()">📋 결과 복사하기</button>
    <span id="copy-status"></span>
  </div>

  ${renderAwardsCardsHtml(awards)}

  <textarea id="share-text" readonly style="position:absolute; left:-9999px;">${escapeHtml(markdown)}</textarea>

  ${renderRankingTablesHtml(players)}

  <script>
    function copyShareText() {
      const ta = document.getElementById('share-text');
      const status = document.getElementById('copy-status');
      ta.focus();
      ta.select();
      const done = (ok) => { status.textContent = ok ? '복사됐어요! ✓' : '복사 실패'; setTimeout(() => { status.textContent = ''; }, 3000); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(ta.value).then(() => done(true)).catch(() => {
          try { done(document.execCommand('copy')); } catch (e) { done(false); }
        });
      } else {
        try { done(document.execCommand('copy')); } catch (e) { done(false); }
      }
    }
  </script>
</body></html>`;
}

// ---- results history (list saved dates + load one date's saved text back) ----

async function listResultEntries(env) {
  const listUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/results`;
  const listResp = await fetch(listUrl, { headers: ghHeaders(env) });
  if (listResp.status === 404) return [];
  if (!listResp.ok) throw new Error(`GitHub list error: ${await listResp.text()}`);
  const entries = await listResp.json();
  return entries.filter(e => e.type === 'file' && e.name.endsWith('.txt'));
}

async function handleListResultDates(env, origin) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' };
  try {
    const entries = await listResultEntries(env);
    const dates = entries.map(e => e.name.replace(/\.txt$/, '')).sort().reverse();
    return new Response(JSON.stringify({ dates }), { status: 200, headers });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers });
  }
}

async function handleGetResultDate(env, origin, date) {
  const headers = { ...corsHeaders(origin), 'Content-Type': 'application/json; charset=utf-8' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return new Response(JSON.stringify({ error: 'Invalid date' }), { status: 400, headers });
  }
  const apiUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/results/${date}.txt`;
  const getResp = await fetch(apiUrl, { headers: ghHeaders(env) });
  if (getResp.status === 404) {
    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers });
  }
  if (!getResp.ok) {
    return new Response(JSON.stringify({ error: `GitHub error: ${await getResp.text()}` }), { status: 502, headers });
  }
  const info = await getResp.json();
  const content = base64ToUtf8(info.content.replace(/\n/g, ''));
  return new Response(JSON.stringify({ date, content }), { status: 200, headers });
}

// ---- fetch + routing ----

async function fetchResultFiles(env) {
  const txtFiles = await listResultEntries(env);

  const files = await Promise.all(txtFiles.map(async (entry) => {
    const fileResp = await fetch(entry.url, { headers: ghHeaders(env) });
    if (!fileResp.ok) return null;
    const info = await fileResp.json();
    const content = base64ToUtf8(info.content.replace(/\n/g, ''));
    const date = entry.name.replace(/\.txt$/, '');
    return { date, content };
  }));

  return files.filter(Boolean);
}

async function handleStats(env) {
  let files;
  try {
    files = await fetchResultFiles(env);
  } catch (e) {
    return new Response(String(e.message || e), { status: 502 });
  }
  const agg = buildAggregates(files);
  // 통계·수상은 현재 회원만 대상 (게스트·탈퇴자 제외). 회원의 경기 기록은
  // 파트너/상대가 비회원이어도 그대로 반영된다.
  const players = agg.players.filter(p => MEMBERS.has(p.name));
  const pairs = agg.pairs.filter(pr => pr.players.every(n => MEMBERS.has(n)));
  const h2h = agg.h2h.filter(e => MEMBERS.has(e.x) && MEMBERS.has(e.y));
  const awards = computeAwards(players, pairs, h2h, files.length);
  const markdown = renderAwardsMarkdown(awards);
  const html = renderStatsHtml(players, awards, markdown);
  return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === '/stats' && request.method === 'GET') {
      return handleStats(env);
    }
    if (url.pathname === '/results' && request.method === 'GET') {
      return handleListResultDates(env, origin);
    }
    const resultDateMatch = url.pathname.match(/^\/results\/([^/]+)$/);
    if (resultDateMatch && request.method === 'GET') {
      return handleGetResultDate(env, origin, decodeURIComponent(resultDateMatch[1]));
    }
    if (url.pathname === '/state' && request.method === 'GET') {
      return handleGetState(env, origin);
    }
    if (url.pathname === '/state' && request.method === 'POST') {
      return handleSaveState(request, env, origin);
    }
    if (url.pathname === '/' && request.method === 'POST') {
      return handleSaveResults(request, env, origin);
    }
    return new Response('Not found', { status: 404 });
  },
};
