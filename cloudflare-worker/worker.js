/**
 * Cloudflare Worker: Google Photos proxy for Aviation gallery
 *
 * Required secrets (set via: wrangler secret put <NAME>):
 *   GOOGLE_CLIENT_ID       - from Google Cloud OAuth credentials
 *   GOOGLE_CLIENT_SECRET   - from Google Cloud OAuth credentials
 *   GOOGLE_REFRESH_TOKEN   - from scripts/get_google_token.js
 *   ALBUM_ID               - printed by scripts/get_google_token.js
 */

const ALLOWED_ORIGINS = [
  'https://karthikpullalarevu.github.io',
  'http://localhost:4000', // Jekyll dev server
  'http://127.0.0.1:4000',
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

async function getAccessToken(env) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function fetchAllPhotos(accessToken, albumId) {
  const items = [];
  let pageToken = null;

  do {
    const body = { albumId, pageSize: 100 };
    if (pageToken) body.pageToken = pageToken;

    const response = await fetch('https://photoslibrary.googleapis.com/v1/mediaItems:search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();
    if (data.mediaItems) items.push(...data.mediaItems);
    pageToken = data.nextPageToken || null;
  } while (pageToken && items.length < 300);

  return items.map((item) => ({
    id: item.id,
    // =w600-h400-c crops to fit; use =w600 for proportional resize
    thumbnail: `${item.baseUrl}=w600-h400-c`,
    full: `${item.baseUrl}=w2048`,
    description: item.description || '',
    filename: item.filename,
    date: item.mediaMetadata?.creationTime || '',
  }));
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers });
    }

    // Cache responses for 1 hour to avoid hammering the API
    const cache = caches.default;
    const cacheKey = new Request('https://cache.internal/aviation-photos', request);
    const cached = await cache.match(cacheKey);
    if (cached) {
      const res = new Response(cached.body, cached);
      Object.entries(headers).forEach(([k, v]) => res.headers.set(k, v));
      res.headers.set('X-Cache', 'HIT');
      return res;
    }

    try {
      const accessToken = await getAccessToken(env);
      const photos = await fetchAllPhotos(accessToken, env.ALBUM_ID);

      const body = JSON.stringify({ photos, count: photos.length });
      const response = new Response(body, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=3600',
          'X-Cache': 'MISS',
        },
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      console.error(error);
      return new Response(
        JSON.stringify({ error: 'Failed to fetch photos', message: error.message }),
        { status: 500, headers: { ...headers, 'Content-Type': 'application/json' } }
      );
    }
  },
};
