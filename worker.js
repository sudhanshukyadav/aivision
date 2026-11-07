export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // ------------------------------------------------------------
      // 1. COMPOSITE AUTHENTICATION: (location_id + username)
      // ------------------------------------------------------------
      if ((pathname === '/api/login' || pathname === '/api/auth/login') && request.method === 'POST') {
        // Safe JSON parsing of request body
        let body = {};
        try {
          body = await request.json();
        } catch (e) {
          return jsonResponse({ status: 'error', error: 'Invalid JSON request payload.' }, 400);
        }

        const rawLoc = String(body.locationId || body.siteId || body.location || '').trim();
        const rawUser = String(body.username || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !rawUser || !password) {
          return jsonResponse({ status: 'error', error: 'Location ID, username, and password required.' }, 400);
        }

        if (!env.DB) {
          return jsonResponse({ status: 'error', error: 'Database binding (env.DB) is missing.' }, 500);
        }

        let user = null;
        try {
          user = await env.DB.prepare(
            `SELECT * FROM users 
             WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) 
               AND TRIM(LOWER(username)) = TRIM(LOWER(?)) 
             LIMIT 1`
          ).bind(rawLoc, rawUser).first();
        } catch (dbErr) {
          console.error('Database query error:', dbErr);
          return jsonResponse({ status: 'error', error: 'Database query failed: ' + dbErr.message }, 500);
        }

        if (!user) {
          return jsonResponse({ status: 'error', error: `User "${rawUser}" not found at location "${rawLoc}".` }, 401);
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({ status: 'error', error: 'Authentication failed: Incorrect password.' }, 401);
        }

        const fixedLocationId = user.location_id.trim();
        
        let locationMeta = { location_id: fixedLocationId, description: 'Facility' };
        try {
          const locRes = await env.DB.prepare(
            `SELECT location_id, description, address FROM locations WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?))`
          ).bind(fixedLocationId).first();
          if (locRes) locationMeta = locRes;
        } catch (e) {}

        let cameraRecords = { results: [] };
        try {
          cameraRecords = await env.DB.prepare(
            `SELECT camera_id, location_id, name FROM cameras WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) ORDER BY camera_id ASC`
          ).bind(fixedLocationId).all();
        } catch (e) {}

        const cleanCameraList = (cameraRecords.results || []).length > 0
          ? cameraRecords.results.map(c => ({ name: (c.name || c.camera_id || 'apcam').trim() }))
          : [{ name: 'apcam' }];

        return jsonResponse({
          status: 'success',
          success: true,
          token: `session_${user.user_id}_${Date.now()}`,
          user: {
            userId: user.user_id,
            username: user.username,
            role: user.role || 'viewer',
            locationId: fixedLocationId,
            location: locationMeta,
            cameras: cleanCameraList
          }
        });
      }

      // ------------------------------------------------------------
      // 2. CHECK / REQUEST MOTION CLIP (Option B)
      // ------------------------------------------------------------
      if (pathname === '/api/motion/check' && (request.method === 'POST' || request.method === 'GET')) {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cameraName = (url.searchParams.get('cam') || 'apcam').trim().toLowerCase();
        let file = (url.searchParams.get('file') || '').trim();

        if (!file) {
          return jsonResponse({ error: 'Parameter "file" is required.' }, 400);
        }
        if (!file.endsWith('.mp4')) {
          file = `${file}.mp4`;
        }

        const videoKey = `${loc}/motion/${cameraName}/${file}`;

        // 1. Check if the file is ALREADY stored in R2
        const existing = await env.MEDIA_BUCKET.head(videoKey);
        if (existing) {
          return jsonResponse({
            status: 'ready',
            cached: true,
            key: videoKey,
            playbackUrl: `/api/motion/latest?location=${loc}&cam=${cameraName}&file=${encodeURIComponent(file)}`
          });
        }

        // 2. Not in R2: Drop request ticket marker for r2_watcher.py
        const markerKey = `${loc}/requests/${cameraName}__${file}.req`;
        if (!(await env.MEDIA_BUCKET.head(markerKey))) {
          await env.MEDIA_BUCKET.put(markerKey, new Uint8Array([1]), {
            httpMetadata: { contentType: 'application/json' }
          });
        }

        return jsonResponse({
          status: 'fetching',
          cached: false,
          key: videoKey,
          marker: markerKey,
          message: 'Requested from local disk'
        });
      }

      // ------------------------------------------------------------
      // 3. CAMERA SNAPSHOT HISTORY LISTING (/api/snapshots/list)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshots/list' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cam = (url.searchParams.get('cam') || 'apcam').toLowerCase();
        const snaps = (await listImages(env, `${loc}/snapshots/${cam}/`)).map(o => ({
          key: o.key,
          filename: o.key.split('/').pop(),
          size: o.size,
          uploaded: o.uploaded
        }));

        return jsonResponse({
          status: 'success',
          location: loc,
          camera: cam,
          count: snaps.length,
          snapshots: snaps
        });
      }

      // ------------------------------------------------------------
      // 4. SITES LISTING (/api/sites)
      // ------------------------------------------------------------
      if (pathname === '/api/sites' && request.method === 'GET') {
        let siteList = [];
        if (env.DB) {
          try {
            const rows = await env.DB.prepare(
              `SELECT location_id, description, address FROM locations ORDER BY location_id ASC`
            ).all();

            siteList = (rows.results || []).map(r => ({
              locationId: r.location_id,
              label: r.description ? `${r.location_id} — ${r.description}` : r.location_id
            }));
          } catch (e) {}
        }

        return jsonResponse({ status: 'success', sites: siteList });
      }

      // ------------------------------------------------------------
      // 5. SNAPSHOT RETRIEVAL (/api/snapshot/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || 'HQ-AD').trim().toUpperCase();
        const cameraName = (url.searchParams.get('cam') || 'apcam').trim().toLowerCase();
        const index = Math.max(0, parseInt(url.searchParams.get('index') || '0', 10));
        const isJson = url.searchParams.has('json');

        const count = Math.min(50, Math.max(1, parseInt(url.searchParams.get('count') || '1', 10) || 1));
        const prefix = `${rawLoc}/snapshots/${cameraName}/`;
        const requestedKey = url.searchParams.get('key');

        let selectedKey = null;
        if (requestedKey) {
          if (!requestedKey.startsWith(prefix)) return jsonResponse({ error: 'Key does not match location/camera' }, 400);
          selectedKey = requestedKey;
        } else {
          const images = await listImages(env, prefix);
          if (images.length === 0) {
            if (isJson) return jsonResponse({ status: 'success', snapshots: [] });
            return new Response(generatePlaceholderSvg(rawLoc, cameraName), {
              status: 200,
              headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }
            });
          }
          if (isJson) {
            const slice = images.slice(index, index + count);
            const first = slice[0] || images[images.length - 1];
            return jsonResponse({
              status: 'success',
              key: first.key,
              uploaded: first.uploaded,
              snapshots: slice.map(o => ({ key: o.key, uploaded: o.uploaded, size: o.size }))
            });
          }
          selectedKey = images[Math.min(index, images.length - 1)].key;
        }

        const object = await env.MEDIA_BUCKET.get(selectedKey, {
          onlyIf: request.headers.get('If-None-Match') ? { etagDoesNotMatch: request.headers.get('If-None-Match').replace(/^W\//, '').replace(/"/g, '') } : undefined
        });
        if (!object) return jsonResponse({ error: 'Snapshot missing' }, 404);

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('ETag', object.httpEtag);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cache-Control', requestedKey ? 'private, max-age=86400' : 'no-cache');
        setDownloadHeader(headers, url, selectedKey.split('/').pop());
        if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 5b. CAMERA LIST FOR A LOCATION (/api/cameras)
      // ------------------------------------------------------------
      if (pathname === '/api/cameras' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').trim().toUpperCase();
        let cameras = [];
        if (env.DB) {
          try {
            const rows = await env.DB.prepare(
              `SELECT camera_id, name FROM cameras WHERE TRIM(UPPER(location_id)) = ? ORDER BY camera_id ASC`
            ).bind(loc).all();
            cameras = (rows.results || [])
              .map(c => String(c.name || c.camera_id || '').trim().toLowerCase())
              .filter(Boolean);
          } catch (e) {}
        }
        return jsonResponse({ status: 'success', location: loc, cameras });
      }

      // ------------------------------------------------------------
      // 6. MOTION VIDEO STREAMING WITH BYTE RANGE (/api/motion/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/motion/latest' && (request.method === 'GET' || request.method === 'HEAD')) {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cameraName = (url.searchParams.get('cam') || 'apcam').trim().toLowerCase();
        let requestedFile = url.searchParams.get('file');

        if (!requestedFile) {
          return new Response('File query parameter is required', { status: 400 });
        }
        if (!requestedFile.endsWith('.mp4')) requestedFile += '.mp4';
        const targetKey = `${loc}/motion/${cameraName}/${requestedFile}`;

        const head = await env.MEDIA_BUCKET.head(targetKey);
        if (!head) {
          return new Response(`Clip not found in R2: ${targetKey}`, { status: 404 });
        }
        const size = head.size;

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('ETag', head.httpEtag);
        setDownloadHeader(headers, url, requestedFile);

        const span = parseRange(request.headers.get('Range'), size);
        if (span === 'invalid') {
          headers.set('Content-Range', `bytes */${size}`);
          return new Response(null, { status: 416, headers });
        }

        if (request.method === 'HEAD') {
          headers.set('Content-Length', String(span ? span.length : size));
          return new Response(null, { status: span ? 206 : 200, headers });
        }

        const videoObject = await env.MEDIA_BUCKET.get(targetKey, span ? { range: span } : undefined);
        if (!videoObject) {
          return new Response(`Clip not found in R2: ${targetKey}`, { status: 404 });
        }

        if (span) {
          headers.set('Content-Range', `bytes ${span.offset}-${span.offset + span.length - 1}/${size}`);
          headers.set('Content-Length', String(span.length));
          return new Response(videoObject.body, { status: 206, headers });
        }

        headers.set('Content-Length', String(size));
        return new Response(videoObject.body, { status: 200, headers });
      }

      // ------------------------------------------------------------
      // 7. STATIC SPA SERVING
      // ------------------------------------------------------------
      if (env.ASSETS) {
        let response = await env.ASSETS.fetch(request);
        if (response.status === 404 && !pathname.includes('.')) {
          const htmlUrl = new URL(request.url);
          htmlUrl.pathname = `${pathname}.html`;
          const htmlResponse = await env.ASSETS.fetch(new Request(htmlUrl, request));
          if (htmlResponse.status === 200) return htmlResponse;
        }
        return response;
      }

      return new Response('AISYS Edge API operational.', { status: 200 });

    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Edge Runtime Error' }, 500);
    }
  }
};

function setDownloadHeader(headers, url, fallbackName) {
  if (!url.searchParams.has('download')) return;
  const ext = (fallbackName.match(/\.[a-z0-9]+$/i) || [''])[0];
  let name = (url.searchParams.get('name') || fallbackName).replace(/[^\w.\-]+/g, '_').slice(0, 120);
  if (ext && !name.toLowerCase().endsWith(ext.toLowerCase())) name += ext;
  headers.set('Content-Disposition', `attachment; filename="${name}"`);
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

function captureTimeOf(key) {
  const m = /(\d{8})_(\d{6})/.exec(key.split('/').pop() || '');
  return m ? m[1] + m[2] : null;
}

async function listImages(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.MEDIA_BUCKET.list({ prefix, limit: 1000, cursor });
    for (const o of page.objects || []) {
      if (o.size > 0 && /\.(jpe?g|png|webp)$/i.test(o.key)) out.push(o);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => {
    const ca = captureTimeOf(a.key), cb = captureTimeOf(b.key);
    if (ca && cb && ca !== cb) return ca < cb ? 1 : -1;
    return new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime();
  });
  return out;
}

async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  if (storedHash === inputPassword) return true;
  const data = new TextEncoder().encode(inputPassword);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  return storedHash.toLowerCase() === hashHex.toLowerCase();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range'
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
      'Access-Control-Max-Age': '86400'
    }
  });
}

function generatePlaceholderSvg(location, camera) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="100%" height="100%" fill="#0a0f1d"/><text x="320" y="180" fill="#64748b" font-family="sans-serif" font-size="14" text-anchor="middle">Awaiting Snapshot (${location} / ${camera})</text></svg>`;
}
