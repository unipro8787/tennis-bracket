// Cloudflare Worker for the tennis bracket app.
//  - POST /        : commits the submitted results text to results/<date>.txt
//  - GET  /stats    : reads every results/*.txt file and renders an awards
//                      report (출석왕/승률왕/케미 등) plus the rankings table
// The GitHub token stays in the Worker's secret store — it is never sent to
// or readable from the public page.

const OWNER = 'unipro8787';
const REPO = 'tennis-bracket';
const ALLOWED_ORIGIN = 'https://unipro8787.github.io';

// eligibility / sample-size floors for the awards below
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

// ---- parsing ----

// mirrors the line format written by buildResultsText() in index.html:
//   휴식: A, B, C
//   [코트 1] P1 · P2 vs P3 · P4 → 승: P1 · P2 (6:4)
// the trailing "(a:b)" is always teamA's score : teamB's score, regardless
// of who won or whether it was a draw.
function parseResultsFile(text) {
  const events = [];
  const rests = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    const restMatch = line.match(/^휴식:\s*(.+)$/);
    if (restMatch) {
      restMatch[1].split(',').map(s => s.trim()).filter(Boolean).forEach(n => rests.push(n));
      continue;
    }
    const m = line.match(/^\[코트\s*\d+\]\s*(.+?)\s+vs\s+(.+?)\s*→\s*승:\s*(.+)$/);
    if (!m) continue;
    const teamAStr = m[1].trim();
    const teamBStr = m[2].trim();
    const outcome = m[3].trim();
    const teamA = teamAStr.split('·').map(s => s.trim()).filter(Boolean);
    const teamB = teamBStr.split('·').map(s => s.trim()).filter(Boolean);
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
  return { events, rests };
}

function ensurePlayer(stats, name) {
  if (!stats.has(name)) {
    stats.set(name, {
      name, games: 0, wins: 0, losses: 0, draws: 0, rests: 0,
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
    const { events, rests } = parseResultsFile(content);
    rests.forEach(n => { ensurePlayer(stats, n).rests++; });
    const h = date ? half(date) : null;

    events.forEach(({ teamA, teamB, winner, scoreA, scoreB }) => {
      const all = [...teamA, ...teamB];

      all.forEach(n => { ensurePlayer(stats, n).games++; });

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

function computeAwards(players, pairs, h2h) {
  const eligible = players.filter(p => p.games >= MIN_TOTAL_GAMES);
  const eligibleNames = new Set(eligible.map(p => p.name));

  const attendance = [...eligible].sort((a, b) => b.games - a.games).slice(0, 3);

  const winRateTop = eligible
    .map(p => ({ p, rate: rate(p.wins, decided(p)) }))
    .filter(x => x.rate !== null)
    .sort((a, b) => b.rate - a.rate || b.p.wins - a.p.wins)
    .slice(0, 3);

  const pairCandidates = pairs
    .filter(pr => pr.games >= MIN_PAIR_GAMES && eligibleNames.has(pr.players[0]) && eligibleNames.has(pr.players[1]))
    .map(pr => ({ ...pr, rate: rate(pr.wins, pr.games) }));
  const bestPair = pairCandidates.length
    ? pairCandidates.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;
  const worstPair = pairCandidates.length
    ? pairCandidates.reduce((a, b) => (b.rate < a.rate ? b : a)) : null;

  const closeCandidates = eligible
    .map(p => ({ p, games: p.closeGames, rate: rate(p.closeWins, p.closeGames) }))
    .filter(x => x.games >= MIN_CLOSE_GAMES);
  const closeMental = closeCandidates.length
    ? closeCandidates.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;

  const mipCandidates = eligible
    .map(p => {
      const r1 = rate(p.h1Wins, p.h1Games);
      const r2 = rate(p.h2Wins, p.h2Games);
      const delta = (r1 !== null && r2 !== null) ? r2 - r1 : null;
      return { p, r1, r2, delta };
    })
    .filter(x => x.delta !== null && x.p.h1Games >= MIN_HALF_GAMES && x.p.h2Games >= MIN_HALF_GAMES);
  const mip = mipCandidates.length
    ? mipCandidates.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;

  const h2hCandidates = h2h
    .filter(e => e.games >= MIN_H2H_GAMES && eligibleNames.has(e.x) && eligibleNames.has(e.y))
    .map(e => ({ ...e, rate: rate(e.wins, e.games) }));
  const nemesis = h2hCandidates.length
    ? h2hCandidates.reduce((a, b) => (b.rate > a.rate ? b : a)) : null;

  return { attendance, winRateTop, bestPair, worstPair, closeMental, mip, nemesis };
}

const MEDALS = ['🥇', '🥈', '🥉'];

function renderAwardsMarkdown(awards) {
  const L = [];
  L.push('## 🎾 테니스 동호회 어워드 🎾', '');

  L.push('### 🏟️ 코트의 지주 (출석왕)');
  if (awards.attendance.length) {
    L.push('| 순위 | 이름 | 경기 수 |', '|---|---|---|');
    awards.attendance.forEach((p, i) => L.push(`| ${MEDALS[i] || i + 1} | ${p.name} | ${p.games}경기 |`));
    L.push('> "코트가 곧 안방인 분들 🏠"');
  } else {
    L.push(`_최소 ${MIN_TOTAL_GAMES}경기를 채운 회원이 아직 없어요._`);
  }
  L.push('');

  L.push('### 🏆 승리 보증수표 (승률왕)');
  if (awards.winRateTop.length) {
    L.push('| 순위 | 이름 | 승률 | 전적 |', '|---|---|---|---|');
    awards.winRateTop.forEach((x, i) => {
      L.push(`| ${MEDALS[i] || i + 1} | ${x.p.name} | ${pct(x.rate)} | ${x.p.wins}승 ${x.p.losses}패 ${x.p.draws}무 |`);
    });
    L.push('> "이 이름이 상대편에 보이면 오늘 코트는 접어야 합니다 😮‍💨"');
  } else {
    L.push('_집계할 데이터가 부족해요._');
  }
  L.push('');

  L.push('### 🤝 환상의 짝꿍 (베스트 케미)');
  if (awards.bestPair) {
    const bp = awards.bestPair;
    L.push(`**${bp.players[0]} & ${bp.players[1]}** — ${bp.games}전 ${bp.wins}승 (승률 ${pct(bp.rate)})`);
    L.push('> "이 조합이 뜨면 상대팀 표정부터 굳는다 🤝"');
  } else {
    L.push(`_함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요._`);
  }
  L.push('');

  L.push('### 💔 비운의 짝꿍 (워스트 케미)');
  if (awards.worstPair) {
    const wp = awards.worstPair;
    L.push(`**${wp.players[0]} & ${wp.players[1]}** — ${wp.games}전 ${wp.wins}승 (승률 ${pct(wp.rate)})`);
    L.push('> "친하긴 한데... 코트에서만은 따로 다니는 게 나을지도? 💔"');
  } else {
    L.push(`_함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요._`);
  }
  L.push('');

  L.push('### 🧠 강철 멘탈 (접전 강자)');
  if (awards.closeMental) {
    const cm = awards.closeMental;
    L.push(`**${cm.p.name}** — 접전(1점 차 이내) ${cm.games}전 승률 ${pct(cm.rate)}`);
    L.push('> "듀스만 가면 눈빛이 달라지는 사람 🧠"');
  } else {
    L.push(`_접전 경기 표본(${MIN_CLOSE_GAMES}경기 이상)이 부족해요._`);
  }
  L.push('');

  L.push('### 📈 폭풍 성장상 (MIP)');
  if (awards.mip) {
    const mp = awards.mip;
    L.push(`**${mp.p.name}** — 상반기 승률 ${pct(mp.r1)} → 하반기 승률 ${pct(mp.r2)} (+${pct(mp.delta)}p)`);
    L.push('> "상반기의 그 사람이 아닙니다 📈"');
  } else {
    L.push(`_상/하반기 각각 ${MIN_HALF_GAMES}경기 이상 뛴 회원이 아직 없어요._`);
  }
  L.push('');

  L.push('### 🏹 천적 관계');
  if (awards.nemesis) {
    const nm = awards.nemesis;
    L.push(`**${nm.x}** ▶ **${nm.y}** — ${nm.games}전 ${nm.wins}승 (승률 ${pct(nm.rate)})`);
    L.push(`> "${nm.y}님, ${nm.x}님만 만나면 유독 안 풀리시더라구요 🏹"`);
  } else {
    L.push(`_같은 상대와 ${MIN_H2H_GAMES}번 이상 맞붙은 기록이 아직 없어요._`);
  }
  L.push('');
  L.push(`_(최소 ${MIN_TOTAL_GAMES}경기 이상 참여한 회원 기준)_`);

  return L.join('\n');
}

function renderAwardsCardsHtml(awards) {
  function card(emoji, title, bodyHtml, quote, empty) {
    return `<div class="award-card">
      <h3>${emoji} ${escapeHtml(title)}</h3>
      ${bodyHtml || `<p class="empty">${escapeHtml(empty)}</p>`}
      ${bodyHtml && quote ? `<p class="quote">${escapeHtml(quote)}</p>` : ''}
    </div>`;
  }

  const attendanceBody = awards.attendance.length ? `<ol class="medal-list">${
    awards.attendance.map((p, i) => `<li><span class="medal">${MEDALS[i] || i + 1}</span> ${escapeHtml(p.name)} <span class="stat">${p.games}경기</span></li>`).join('')
  }</ol>` : '';

  const winRateBody = awards.winRateTop.length ? `<ol class="medal-list">${
    awards.winRateTop.map((x, i) => `<li><span class="medal">${MEDALS[i] || i + 1}</span> ${escapeHtml(x.p.name)} <span class="stat">${pct(x.rate)} (${x.p.wins}승 ${x.p.losses}패 ${x.p.draws}무)</span></li>`).join('')
  }</ol>` : '';

  const bestPairBody = awards.bestPair
    ? `<p class="big"><strong>${escapeHtml(awards.bestPair.players[0])} &amp; ${escapeHtml(awards.bestPair.players[1])}</strong></p>
       <p class="stat">${awards.bestPair.games}전 ${awards.bestPair.wins}승 (승률 ${pct(awards.bestPair.rate)})</p>` : '';

  const worstPairBody = awards.worstPair
    ? `<p class="big"><strong>${escapeHtml(awards.worstPair.players[0])} &amp; ${escapeHtml(awards.worstPair.players[1])}</strong></p>
       <p class="stat">${awards.worstPair.games}전 ${awards.worstPair.wins}승 (승률 ${pct(awards.worstPair.rate)})</p>` : '';

  const closeMentalBody = awards.closeMental
    ? `<p class="big"><strong>${escapeHtml(awards.closeMental.p.name)}</strong></p>
       <p class="stat">접전(1점 차 이내) ${awards.closeMental.games}전 승률 ${pct(awards.closeMental.rate)}</p>` : '';

  const mipBody = awards.mip
    ? `<p class="big"><strong>${escapeHtml(awards.mip.p.name)}</strong></p>
       <p class="stat">상반기 ${pct(awards.mip.r1)} → 하반기 ${pct(awards.mip.r2)} (+${pct(awards.mip.delta)}p)</p>` : '';

  const nemesisBody = awards.nemesis
    ? `<p class="big"><strong>${escapeHtml(awards.nemesis.x)}</strong> ▶ <strong>${escapeHtml(awards.nemesis.y)}</strong></p>
       <p class="stat">${awards.nemesis.games}전 ${awards.nemesis.wins}승 (승률 ${pct(awards.nemesis.rate)})</p>` : '';

  return `<div class="award-grid">
    ${card('🏟️', '코트의 지주 (출석왕)', attendanceBody, '코트가 곧 안방인 분들 🏠', `최소 ${MIN_TOTAL_GAMES}경기를 채운 회원이 아직 없어요.`)}
    ${card('🏆', '승리 보증수표 (승률왕)', winRateBody, '이 이름이 상대편에 보이면 오늘 코트는 접어야 합니다 😮‍💨', '집계할 데이터가 부족해요.')}
    ${card('🤝', '환상의 짝꿍 (베스트 케미)', bestPairBody, '이 조합이 뜨면 상대팀 표정부터 굳는다 🤝', `함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요.`)}
    ${card('💔', '비운의 짝꿍 (워스트 케미)', worstPairBody, '친하긴 한데... 코트에서만은 따로 다니는 게 나을지도? 💔', `함께 ${MIN_PAIR_GAMES}경기 이상 뛴 조합이 아직 없어요.`)}
    ${card('🧠', '강철 멘탈 (접전 강자)', closeMentalBody, '듀스만 가면 눈빛이 달라지는 사람 🧠', `접전 경기 표본(${MIN_CLOSE_GAMES}경기 이상)이 부족해요.`)}
    ${card('📈', '폭풍 성장상 (MIP)', mipBody, '상반기의 그 사람이 아닙니다 📈', `상/하반기 각각 ${MIN_HALF_GAMES}경기 이상 뛴 회원이 아직 없어요.`)}
    ${card('🏹', '천적 관계', nemesisBody, awards.nemesis ? `${awards.nemesis.y}님, ${awards.nemesis.x}님만 만나면 유독 안 풀리시더라구요 🏹` : '', `같은 상대와 ${MIN_H2H_GAMES}번 이상 맞붙은 기록이 아직 없어요.`)}
  </div>
  <p class="sub">(최소 ${MIN_TOTAL_GAMES}경기 이상 참여한 회원 기준)</p>`;
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

// ---- fetch + routing ----

async function fetchResultFiles(env) {
  const listUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/results`;
  const listResp = await fetch(listUrl, { headers: ghHeaders(env) });
  if (listResp.status === 404) return [];
  if (!listResp.ok) throw new Error(`GitHub list error: ${await listResp.text()}`);

  const entries = await listResp.json();
  const txtFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.txt'));

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
  const { players, pairs, h2h } = buildAggregates(files);
  const awards = computeAwards(players, pairs, h2h);
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
    if (request.method === 'POST') {
      return handleSaveResults(request, env, origin);
    }
    return new Response('Not found', { status: 404 });
  },
};
