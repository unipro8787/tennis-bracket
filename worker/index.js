// Cloudflare Worker for the tennis bracket app.
//  - POST /       : commits the submitted results text to results/<date>.txt
//  - GET  /stats  : reads every results/*.txt file and renders a rankings +
//                   front(포)/back(백) position win-rate report
// The GitHub token stays in the Worker's secret store — it is never sent to
// or readable from the public page.

const OWNER = 'unipro8787';
const REPO = 'tennis-bracket';
const ALLOWED_ORIGIN = 'https://unipro8787.github.io';

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

// ---- stats analysis ----

// mirrors the line format written by buildResultsText() in index.html:
//   휴식: A, B, C
//   [코트 1] P1 · P2 vs P3 · P4 → 승: P1 · P2 (6:4)
// the first name in each team is the 포(front) slot, the second is 백(back).
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

    events.push({ teamA, teamB, winner });
  }
  return { events, rests };
}

function ensurePlayer(stats, name) {
  if (!stats.has(name)) {
    stats.set(name, {
      name, games: 0, wins: 0, losses: 0, draws: 0,
      frontGames: 0, frontWins: 0, backGames: 0, backWins: 0, rests: 0,
    });
  }
  return stats.get(name);
}

function buildStats(fileContents) {
  const stats = new Map();
  fileContents.forEach(content => {
    const { events, rests } = parseResultsFile(content);
    rests.forEach(n => { ensurePlayer(stats, n).rests++; });
    events.forEach(({ teamA, teamB, winner }) => {
      const [aFront, aBack] = teamA;
      const [bFront, bBack] = teamB;
      [aFront, aBack, bFront, bBack].forEach(n => { ensurePlayer(stats, n).games++; });
      ensurePlayer(stats, aFront).frontGames++;
      ensurePlayer(stats, bFront).frontGames++;
      ensurePlayer(stats, aBack).backGames++;
      ensurePlayer(stats, bBack).backGames++;

      if (winner === 'draw') {
        [aFront, aBack, bFront, bBack].forEach(n => { ensurePlayer(stats, n).draws++; });
        return;
      }
      const winFront = winner === 'A' ? aFront : bFront;
      const winBack = winner === 'A' ? aBack : bBack;
      const loseFront = winner === 'A' ? bFront : aFront;
      const loseBack = winner === 'A' ? bBack : aBack;
      ensurePlayer(stats, winFront).wins++;
      ensurePlayer(stats, winBack).wins++;
      ensurePlayer(stats, loseFront).losses++;
      ensurePlayer(stats, loseBack).losses++;
      ensurePlayer(stats, winFront).frontWins++;
      ensurePlayer(stats, winBack).backWins++;
    });
  });
  return [...stats.values()];
}

function rate(wins, games) {
  return games > 0 ? wins / games : null;
}

function pct(r) {
  return r === null ? '—' : `${(r * 100).toFixed(0)}%`;
}

// per-player front-vs-back leaning; a MIN_GAMES floor avoids reading noise
// into a 1-game sample as a real tendency. (note: club-wide front/back win
// rates are always ~equal by construction — only the per-player split is
// informative, since each decided match has exactly one winning front slot
// and one winning back slot.)
function posLeaning(p) {
  const MIN_GAMES = 3;
  const fr = rate(p.frontWins, p.frontGames);
  const br = rate(p.backWins, p.backGames);
  if (fr === null || br === null || p.frontGames < MIN_GAMES || p.backGames < MIN_GAMES) return '표본 부족';
  const diff = fr - br;
  if (Math.abs(diff) < 0.1) return '차이 없음';
  return diff > 0 ? '포에서 강함' : '백에서 강함';
}

function renderStatsHtml(players) {
  const ranked = players
    .filter(p => p.games > 0)
    .sort((a, b) => {
      const decidedA = a.wins + a.losses + a.draws;
      const decidedB = b.wins + b.losses + b.draws;
      const ra = rate(a.wins, decidedA) ?? -1;
      const rb = rate(b.wins, decidedB) ?? -1;
      if (rb !== ra) return rb - ra;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return b.games - a.games;
    });

  const rankRows = ranked.map((p, i) => {
    const decided = p.wins + p.losses + p.draws;
    return `<tr>
      <td>${i + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${p.games}</td>
      <td>${p.wins}</td>
      <td>${p.losses}</td>
      <td>${p.draws}</td>
      <td>${pct(rate(p.wins, decided))}</td>
      <td>${p.rests}</td>
    </tr>`;
  }).join('');

  const posRows = ranked.map(p => `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${p.frontGames}</td>
      <td>${p.frontWins}</td>
      <td>${pct(rate(p.frontWins, p.frontGames))}</td>
      <td>${p.backGames}</td>
      <td>${p.backWins}</td>
      <td>${pct(rate(p.backWins, p.backGames))}</td>
      <td>${posLeaning(p)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>테니스 복식조 통계</title>
<style>
  body { font-family: "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; background:#f2f6f1; color:#17241c; margin:0; padding:24px; }
  h1 { font-size:1.4rem; margin:0 0 4px; }
  p.sub { color:#5f6f66; margin:0 0 24px; font-size:0.88rem; max-width:60ch; }
  table { border-collapse:collapse; width:100%; margin-bottom:32px; background:#fff; border-radius:10px; overflow:hidden; box-shadow:0 1px 2px rgba(0,0,0,0.05); }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #dde4da; font-size:0.9rem; white-space:nowrap; }
  th { background:#e4f1e9; color:#145c39; font-size:0.78rem; }
  h2 { font-size:1.05rem; margin:24px 0 10px; }
  .empty { color:#5f6f66; padding:20px 0; }
  .table-scroll { overflow-x:auto; }
</style></head>
<body>
  <h1>테니스 복식조 통계</h1>
  <p class="sub">저장된 모든 결과 파일(results/*.txt)을 집계한 결과입니다. 점수를 입력하지 않은 "미정" 경기는 제외됩니다.</p>
  ${ranked.length === 0 ? '<p class="empty">집계할 경기 결과가 없습니다.</p>' : `
  <h2>순위</h2>
  <div class="table-scroll"><table>
    <thead><tr><th>순위</th><th>이름</th><th>경기</th><th>승</th><th>패</th><th>무</th><th>승률</th><th>휴식</th></tr></thead>
    <tbody>${rankRows}</tbody>
  </table></div>
  <h2>포지션별(포/백) 승률</h2>
  <div class="table-scroll"><table>
    <thead><tr><th>이름</th><th>포 경기</th><th>포 승</th><th>포 승률</th><th>백 경기</th><th>백 승</th><th>백 승률</th><th>비고</th></tr></thead>
    <tbody>${posRows}</tbody>
  </table></div>
  `}
</body></html>`;
}

async function handleStats(env) {
  const listUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/results`;
  const listResp = await fetch(listUrl, { headers: ghHeaders(env) });

  if (listResp.status === 404) {
    return new Response(renderStatsHtml([]), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (!listResp.ok) {
    return new Response(`GitHub list error: ${await listResp.text()}`, { status: 502 });
  }

  const entries = await listResp.json();
  const txtFiles = entries.filter(e => e.type === 'file' && e.name.endsWith('.txt'));

  const fileContents = await Promise.all(txtFiles.map(async (entry) => {
    const fileResp = await fetch(entry.url, { headers: ghHeaders(env) });
    if (!fileResp.ok) return '';
    const info = await fileResp.json();
    return base64ToUtf8(info.content.replace(/\n/g, ''));
  }));

  const players = buildStats(fileContents);
  const html = renderStatsHtml(players);
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
