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
        const body = await request.json().catch(() => ({}));
        const rawLoc = String(body.locationId || body.siteId || body.location || '').trim();
        const rawUser = String(body.username || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !rawUser || !password) {
          return jsonResponse({ status: 'error', error: 'Location ID, username, and password required.' }, 400);
        }

        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) 
             AND TRIM(LOWER(username)) = TRIM(LOWER(?)) 
           LIMIT 1`
        ).bind(rawLoc, rawUser).first();

        if (!user) {
          return jsonResponse({ status: 'error', error: `User "${rawUser}" not found at location "${rawLoc}".` }, 401);
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({ status: 'error', error: 'Authentication failed: Incorrect password.' }, 401);
        }

        const fixedLocationId = user.location_id.trim();
        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?))`
        ).bind(fixedLocationId).first() || { location_id: fixedLocationId, description: 'Facility' };

        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) ORDER BY camera_id ASC`
        ).bind(fixedLocationId).all();

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
        await env.MEDIA_BUCKET.put(markerKey, new Uint8Array([1]), {
          httpMetadata: { contentType: 'application/json' }
        });

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
        const cursor = url.searchParams.get('cursor') || undefined;

        const prefix = `${loc}/snapshots/${cam}/`;
        const list = await env.MEDIA_BUCKET.list({ prefix, limit: 100, cursor });

        const snaps = (list.objects || [])
          .filter(o => o.size > 0 && /\.(jpe?g|png|webp)$/i.test(o.key))
          .map(o => ({
            key: o.key,
            filename: o.key.split('/').pop(),
            size: o.size,
            uploaded: o.uploaded
          }));

        snaps.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());

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
        const rows = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations ORDER BY location_id ASC`
        ).all();

        const siteList = (rows.results || []).map(r => ({
          locationId: r.location_id,
          label: r.description ? `${r.location_id} — ${r.description}` : r.location_id
        }));

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

        const prefix = `${rawLoc}/snapshots/${cameraName}/`;
        const list = await env.MEDIA_BUCKET.list({ prefix, limit: 60 });
        const images = (list.objects || []).filter(o => o.size > 0 && /\.(jpe?g|png|webp)$/i.test(o.key));

        if (images.length === 0) {
          if (isJson) return jsonResponse({ error: 'No snapshots available' }, 404);
          return new Response(generatePlaceholderSvg(rawLoc, cameraName), {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml' }
          });
        }

        images.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
        const selectedObject = images[Math.min(index, images.length - 1)];

        if (isJson) {
          return jsonResponse({
            status: 'success',
            key: selectedObject.key,
            uploaded: selectedObject.uploaded
          });
        }

        const object = await env.MEDIA_BUCKET.get(selectedObject.key);
        if (!object) return jsonResponse({ error: 'Snapshot missing' }, 404);

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('Access-Control-Allow-Origin', '*');
        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 6. MOTION VIDEO STREAMING WITH BYTE RANGE (/api/motion/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/motion/latest' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cameraName = (url.searchParams.get('cam') || 'apcam').trim().toLowerCase();
        let requestedFile = url.searchParams.get('file');

        if (!requestedFile) {
          return new Response('File query parameter is required', { status: 400 });
        }
        if (!requestedFile.endsWith('.mp4')) requestedFile += '.mp4';
        const targetKey = `${loc}/motion/${cameraName}/${requestedFile}`;

        const rangeHeader = request.headers.get('Range');
        const videoObject = await env.MEDIA_BUCKET.get(targetKey, {
          range: rangeHeader ? request.headers : undefined
        });

        if (!videoObject) {
          return new Response(`Clip not found in R2: ${targetKey}`, { status: 404 });
        }

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'public, max-age=86400');

        if (rangeHeader && videoObject.range) {
          const range = videoObject.range;
          headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${videoObject.size}`);
          headers.set('Content-Length', String(range.length));
          return new Response(videoObject.body, { status: 206, headers });
        }

        headers.set('Content-Length', String(videoObject.size));
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
