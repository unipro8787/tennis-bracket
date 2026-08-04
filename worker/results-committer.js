// Cloudflare Worker: receives the results text from the bracket page and
// commits it to results/<date>.txt in the GitHub repo via the Contents API.
// The GitHub token stays in the Worker's secret store — it is never sent to
// or readable from the public page.

const OWNER = 'unipro8787';
const REPO = 'tennis-bracket';
const ALLOWED_ORIGIN = 'https://unipro8787.github.io';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : 'null',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function utf8ToBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers });
    }
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
    const ghHeaders = {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'tennis-bracket-results-worker',
    };

    // look up the existing file's sha so same-day re-saves update it instead of failing
    let sha;
    const getResp = await fetch(apiUrl, { headers: ghHeaders });
    if (getResp.status === 200) {
      const info = await getResp.json();
      sha = info.sha;
    } else if (getResp.status !== 404) {
      return new Response(`GitHub lookup error: ${await getResp.text()}`, { status: 502, headers });
    }

    const putResp = await fetch(apiUrl, {
      method: 'PUT',
      headers: ghHeaders,
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
  },
};
