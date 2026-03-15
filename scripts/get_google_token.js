#!/usr/bin/env node
/**
 * One-time script to get a Google OAuth refresh token and find your Aviation album ID.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com
 *   2. Create a new project (or select existing)
 *   3. Enable "Google Photos Library API"
 *   4. Go to APIs & Services → Credentials → Create Credentials → OAuth client ID
 *      - Application type: Desktop app
 *      - Download the JSON or note the Client ID and Client Secret
 *   5. Under OAuth consent screen, add your Google account as a Test User
 *
 * Usage:
 *   export GOOGLE_CLIENT_ID=your_client_id_here
 *   export GOOGLE_CLIENT_SECRET=your_client_secret_here
 *   node scripts/get_google_token.js
 */

const http = require('http');
const https = require('https');
const { exec } = require('child_process');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = 'https://www.googleapis.com/auth/photoslibrary.readonly';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Error: Missing credentials.\n');
  console.error('  export GOOGLE_CLIENT_ID=your_client_id');
  console.error('  export GOOGLE_CLIENT_SECRET=your_client_secret');
  console.error('  node scripts/get_google_token.js\n');
  process.exit(1);
}

function openBrowser(url) {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
      ? `start "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.log('\nCould not open browser automatically. Please open the URL above manually.');
  });
}

function httpsPost(url, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
    https
      .get({ hostname: u.hostname, path: u.pathname + u.search, headers }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

function waitForCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url.startsWith('/callback')) return;
      const url = new URL(req.url, 'http://localhost:3000');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        res.end(`<h2 style="font-family:sans-serif;color:red">Error: ${error}</h2><p>You can close this tab.</p>`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end('<h2 style="font-family:sans-serif;color:green">Authorization successful!</h2><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });

    server.listen(3000, () => {});
    server.on('error', reject);
  });
}

function printManualNote() {
  console.log('\n── Manual album ID lookup ───────────────────────────────');
  console.log('Open your Aviation album in Google Photos in a browser.');
  console.log('The URL will look like:');
  console.log('  https://photos.google.com/album/AF1QipXXXXXXXXXXXX');
  console.log('                                   ^^^^^^^^^^^^^^^^^^^');
  console.log('That last segment is NOT the API album ID unfortunately.');
  console.log('');
  console.log('Instead, run this curl to list albums with your access token:');
  console.log(`  curl -H "Authorization: Bearer ACCESS_TOKEN" \\`);
  console.log(`    "https://photoslibrary.googleapis.com/v1/albums?pageSize=50"`);
  console.log('');
  console.log('Your access token (valid ~1 hour from now):');
}

async function main() {
  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`; // forces refresh_token to be returned

  console.log('\n=== Google Photos OAuth Token Generator ===\n');
  console.log('Opening your browser for Google authorization...');
  console.log('\nAuth URL (open manually if browser does not launch):');
  console.log(authUrl + '\n');
  openBrowser(authUrl);

  console.log('Waiting for authorization (listening on http://localhost:3000)...\n');
  const code = await waitForCode();

  console.log('Code received. Exchanging for tokens...\n');
  const tokens = await httpsPost('https://oauth2.googleapis.com/token', {
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  });

  if (!tokens.refresh_token) {
    console.error('No refresh_token returned. This usually means you have previously authorized this app.');
    console.error('Revoke access at https://myaccount.google.com/permissions and run this script again.\n');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║              SAVE YOUR REFRESH TOKEN             ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(tokens.refresh_token);
  console.log('');

  // Show what scopes were actually granted
  const tokenInfo = await httpsGet(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`,
    null
  );
  console.log('\nScopes granted to this token:');
  console.log(' ', tokenInfo.scope || '(none)');
  const hasPhotos = (tokenInfo.scope || '').includes('photoslibrary');
  if (!hasPhotos) {
    console.error('\nERROR: photoslibrary scope was NOT granted.');
    console.error('Go to Google Cloud → OAuth consent screen → Data Access');
    console.error('and make sure "https://www.googleapis.com/auth/photoslibrary" is listed.');
    console.error('Then revoke app access at myaccount.google.com/permissions and re-run.\n');
    process.exit(1);
  }

  console.log('Fetching your Google Photos albums...\n');
  const albumsData = await httpsGet(
    'https://photoslibrary.googleapis.com/v1/albums?pageSize=50',
    tokens.access_token
  );

  if (albumsData.error) {
    console.error('API error:', JSON.stringify(albumsData.error, null, 2));
    console.error('\nIf the error is 403/PERMISSION_DENIED, see the note below.');
    printManualNote();
    return;
  }

  const albums = albumsData.albums || [];
  if (!albums.length) {
    console.log('API returned no albums. Raw response:', JSON.stringify(albumsData, null, 2));
    printManualNote();
    return;
  }

  console.log('Your albums:');
  albums.forEach((a) => {
    const count = a.mediaItemsCount ? `(${a.mediaItemsCount} photos)` : '';
    console.log(`  ${a.title.padEnd(45)} ${count.padEnd(15)} ID: ${a.id}`);
  });

  const aviation = albums.find((a) => a.title.toLowerCase().includes('aviation'));
  if (aviation) {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║           AVIATION ALBUM FOUND                   ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log(`Title: ${aviation.title}`);
    console.log(`ID:    ${aviation.id}`);
    console.log(`Count: ${aviation.mediaItemsCount || 'unknown'} photos`);
  } else {
    console.log('\nNo album with "aviation" in the name found. Use an ID from the list above.');
  }

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║              NEXT STEPS                          ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('\nRun these commands from the cloudflare-worker/ directory:\n');
  console.log('  npx wrangler secret put GOOGLE_CLIENT_ID');
  console.log('  npx wrangler secret put GOOGLE_CLIENT_SECRET');
  console.log('  npx wrangler secret put GOOGLE_REFRESH_TOKEN');
  console.log('  npx wrangler secret put ALBUM_ID');
  console.log('\nThen deploy:');
  console.log('  npx wrangler deploy');
  console.log('\nFinally, update WORKER_URL in _pages/photography.html with your deployed worker URL.\n');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
