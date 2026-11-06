export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // ------------------------------------------------------------
      // 1. STRICT COMPOSITE AUTHENTICATION: (location_id + username)
      // ------------------------------------------------------------
      if ((pathname === '/api/login' || pathname === '/api/auth/login') && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const rawLoc = String(body.locationId || body.siteId || body.location || '').trim();
        const rawUser = String(body.username || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !rawUser || !password) {
          return jsonResponse({
            status: 'error',
            error: 'Location ID, username, and password are all required.'
          }, 400);
        }

        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) 
             AND TRIM(LOWER(username)) = TRIM(LOWER(?)) 
           LIMIT 1`
        ).bind(rawLoc, rawUser).first();

        if (!user) {
          return jsonResponse({
            status: 'error',
            error: `User "${rawUser}" not found at location "${rawLoc}".`
          }, 401);
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({
            status: 'error',
            error: 'Authentication failed: Incorrect password.'
          }, 401);
        }

        const fixedLocationId = user.location_id.trim();

        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?))`
        ).bind(fixedLocationId).first() || { location_id: fixedLocationId, description: 'Facility' };

        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE TRIM(UPPER(location_id)) = TRIM(UPPER(?)) ORDER BY camera_id ASC`
        ).bind(fixedLocationId).all();

        const siteCameras = cameraRecords.results || [];

        let allowedCameraNames = ['*'];
        try {
          allowedCameraNames = JSON.parse(user.allowed_cameras || '["*"]');
        } catch {
          allowedCameraNames = ['*'];
        }

        let authorizedCameras = siteCameras;
        if (user.role !== 'admin' && !allowedCameraNames.includes('*')) {
          const lowerAllowed = allowedCameraNames.map(c => String(c).toLowerCase());
          authorizedCameras = siteCameras.filter(cam => {
            const cleanName = String(cam.name || cam.camera_id || '').toLowerCase();
            const cleanId = String(cam.camera_id || '').toLowerCase();
            return lowerAllowed.includes(cleanName) || lowerAllowed.includes(cleanId);
          });
        }

        // Standardize output to clean camera names for directory paths
        const cleanCameraList = authorizedCameras.length > 0
          ? authorizedCameras.map(c => ({ name: (c.name || c.camera_id || 'apcam').trim() }))
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
      // 2. DIAGNOSTIC INSPECTOR: /api/r2/inspect
      // ------------------------------------------------------------
      if (pathname === '/api/r2/inspect' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cam = (url.searchParams.get('cam') || 'apcam').toLowerCase();

        const motionPrefix = `${loc}/motion/${cam}/`;
        const snapPrefix = `${loc}/snapshots/${cam}/`;

        const [motionList, snapList] = await Promise.all([
          env.MEDIA_BUCKET.list({ prefix: motionPrefix, limit: 20 }),
          env.MEDIA_BUCKET.list({ prefix: snapPrefix, limit: 10 })
        ]);

        return jsonResponse({
          location: loc,
          camera: cam,
          motion_files: (motionList.objects || []).map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
          snapshot_files: (snapList.objects || []).map(o => ({ key: o.key, size: o.size, uploaded: o.uploaded }))
        });
      }

      // ------------------------------------------------------------
      // 3. SITES LISTING (/api/sites)
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
      // 4. LIVE HLS STREAMING (/live/:file)
      // ------------------------------------------------------------
      if (pathname.startsWith('/live/')) {
        let rawFile = pathname.replace(/^\/live\//, '');
        const location = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();

        if (!rawFile.includes('.')) {
          rawFile = `${rawFile}.m3u8`;
        }

        let r2Key = `${location}/${rawFile}`;
        let object = await env.MEDIA_BUCKET.get(r2Key);

        if (!object && rawFile.includes('/')) {
          const strippedFilename = rawFile.split('/').pop();
          r2Key = `${location}/${strippedFilename}`;
          object = await env.MEDIA_BUCKET.get(r2Key);
        }

        if (!object) {
          return new Response(`Stream segment offline: ${r2Key}`, {
            status: 404,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Cache-Control': 'no-cache, no-store, must-revalidate'
            }
          });
        }

        const isM3U8 = rawFile.endsWith('.m3u8');
        const headers = new Headers();
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Content-Type', object.httpMetadata?.contentType || (isM3U8 ? 'application/vnd.apple.mpegurl' : 'video/mp2t'));
        headers.set('Cache-Control', isM3U8 ? 'no-cache, no-store, must-revalidate' : 'public, max-age=31536000, immutable');

        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 5. SNAPSHOT RETRIEVAL (/api/snapshot/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || 'HQ-AD').trim().toUpperCase();
        const cameraName = (url.searchParams.get('cam') || url.searchParams.get('camera') || url.searchParams.get('name') || 'apcam').trim().toLowerCase();
        const index = Math.max(0, parseInt(url.searchParams.get('index') || '0', 10));
        const isJson = url.searchParams.has('json');

        const prefix = `${rawLoc}/snapshots/${cameraName}/`;
        const list = await env.MEDIA_BUCKET.list({ prefix, limit: 60 });
        const images = (list.objects || []).filter(o => o.size > 0 && /\.(jpe?g|png|webp)$/i.test(o.key));

        if (images.length === 0) {
          if (isJson) return jsonResponse({ error: 'No snapshots available', prefix }, 404);
          return new Response(generatePlaceholderSvg(rawLoc, cameraName), {
            status: 200,
            headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache, no-store' }
          });
        }

        images.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
        const selectedIndex = Math.min(index, images.length - 1);
        const selectedObject = images[selectedIndex];

        if (isJson) {
          return jsonResponse({
            status: 'success',
            index: selectedIndex,
            key: selectedObject.key,
            uploaded: selectedObject.uploaded,
            size: selectedObject.size
          });
        }

        const object = await env.MEDIA_BUCKET.get(selectedObject.key);
        if (!object) {
          return jsonResponse({ error: 'Snapshot object missing from storage' }, 404);
        }

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('ETag', object.httpEtag);
        headers.set('X-AISYS-Snapshot-Index', String(selectedIndex));
        headers.set('X-AISYS-Snapshot-Key', selectedObject.key);
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 6. MOTION VIDEO STREAMING WITH BYTE RANGE (/api/motion/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/motion/latest' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cameraName = (url.searchParams.get('cam') || url.searchParams.get('name') || 'apcam').trim().toLowerCase();
        let requestedFile = url.searchParams.get('file');

        let targetKey = null;

        if (requestedFile) {
          if (!requestedFile.endsWith('.mp4')) requestedFile += '.mp4';
          targetKey = `${loc}/motion/${cameraName}/${requestedFile}`;
        } else {
          const prefix = `${loc}/motion/${cameraName}/`;
          const list = await env.MEDIA_BUCKET.list({ prefix, limit: 30 });
          const clips = (list.objects || []).filter(o => o.key.toLowerCase().endsWith('.mp4'));

          if (clips.length === 0) {
            return new Response(`No motion MP4 files found in R2 for ${cameraName}`, { status: 404 });
          }

          clips.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
          targetKey = clips[0].key;
        }

        const rangeHeader = request.headers.get('Range');
        const videoObject = await env.MEDIA_BUCKET.get(targetKey, {
          range: rangeHeader ? request.headers : undefined
        });

        if (!videoObject) {
          return new Response(`Clip not found: ${targetKey}`, { status: 404 });
        }

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('X-AISYS-Motion-Key', targetKey);

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
          if (htmlResponse.status === 200) {
            return htmlResponse;
          }
        }
        return response;
      }

      return new Response('AISYS Edge API operational.', { status: 200 });

    } catch (err) {
      return jsonResponse({ error: err.message || 'Internal Edge Runtime Error' }, 500);
    }
  }
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  if (storedHash === inputPassword) return true;

  const encoder = new TextEncoder();
  const data = encoder.encode(inputPassword);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

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
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
    <rect width="100%" height="100%" fill="#0a0f1d"/>
    <rect x="2" y="2" width="636" height="356" fill="none" stroke="#1e293b" stroke-width="2"/>
    <circle cx="320" cy="150" r="32" fill="none" stroke="#38bdf8" stroke-width="3" opacity="0.6"/>
    <circle cx="320" cy="150" r="8" fill="#38bdf8" opacity="0.8"/>
    <text x="320" y="215" fill="#f8fafc" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="15" font-weight="600" text-anchor="middle">Awaiting Snapshot</text>
    <text x="320" y="240" fill="#64748b" font-family="-apple-system, BlinkMacSystemFont, sans-serif" font-size="12" text-anchor="middle">${location} / ${camera}</text>
  </svg>
  `.trim();
}
