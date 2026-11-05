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
      // Endpoints: /api/login and /api/auth/login
      // ------------------------------------------------------------
      if ((pathname === '/api/login' || pathname === '/api/auth/login') && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const rawLoc = (body.locationId || body.siteId || body.location || '').trim();
        const rawUser = (body.username || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !rawUser || !password) {
          return jsonResponse({
            status: 'error',
            error: 'Location ID, username, and password are all required.'
          }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const usernameLower = rawUser.toLowerCase();

        // Query strictly on the composite unique pair (location_id, username)
        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE UPPER(location_id) = ? 
             AND LOWER(username) = ? 
           LIMIT 1`
        ).bind(locUpper, usernameLower).first();

        if (!user) {
          return jsonResponse({
            status: 'error',
            error: 'Authentication failed: Invalid Location ID or Username.'
          }, 401);
        }

        // Verify password hash
        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({
            status: 'error',
            error: 'Authentication failed: Incorrect password.'
          }, 401);
        }

        // Canonical fixed location ID from database
        const fixedLocationId = user.location_id;

        // Fetch location details
        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE location_id = ?`
        ).bind(fixedLocationId).first() || { location_id: fixedLocationId, description: 'Active Facility' };

        // Fetch all cameras configured for this specific location
        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE location_id = ? ORDER BY camera_id ASC`
        ).bind(fixedLocationId).all();

        const siteCameras = cameraRecords.results || [];

        // Parse camera permissions
        let allowedCameraIds = ['*'];
        try {
          allowedCameraIds = JSON.parse(user.allowed_cameras || '["*"]');
        } catch {
          allowedCameraIds = ['*'];
        }

        let accessibleCameras = siteCameras;

        // Admins see all cameras; others are filtered by allowed_cameras
        if (user.role !== 'admin' && !allowedCameraIds.includes('*')) {
          const lowerAllowed = allowedCameraIds.map(c => String(c).toLowerCase());
          accessibleCameras = siteCameras.filter(cam =>
            lowerAllowed.includes(String(cam.camera_id).toLowerCase()) ||
            lowerAllowed.includes(String(cam.name || '').toLowerCase())
          );
        }

        return jsonResponse({
          status: 'success',
          success: true,
          token: `session_${user.user_id}_${Date.now()}`,
          user: {
            userId: user.user_id,
            username: user.username,
            role: user.role,                  // Fixed role
            locationId: fixedLocationId,     // Fixed site ID
            location: locationMeta,
            cameras: accessibleCameras        // Fixed camera array
          }
        });
      }

      // ------------------------------------------------------------
      // 2. SITES / LOCATIONS LISTING (/api/sites)
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
      // 3. ADMIN EXPLORER: LOAD TABLES (/api/admin/tables)
      // ------------------------------------------------------------
      if (pathname === '/api/admin/tables' && request.method === 'GET') {
        const adminId = request.headers.get('x-admin-userid');
        const adminUser = await getAdminUser(env, adminId);
        if (!adminUser) {
          return jsonResponse({ success: false, error: 'Unauthorized admin access.' }, 403);
        }

        const [locs, cams, usrs] = await Promise.all([
          env.DB.prepare('SELECT * FROM locations ORDER BY location_id ASC').all(),
          env.DB.prepare('SELECT * FROM cameras ORDER BY location_id ASC, camera_id ASC').all(),
          env.DB.prepare('SELECT user_id, location_id, username, role, allowed_cameras FROM users ORDER BY location_id ASC, username ASC').all()
        ]);

        return jsonResponse({
          success: true,
          tables: {
            locations: locs.results || [],
            cameras: cams.results || [],
            users: usrs.results || []
          }
        });
      }

      // ------------------------------------------------------------
      // 4. ADMIN EXPLORER: SAVE RECORD (/api/admin/tables/save)
      // ------------------------------------------------------------
      if (pathname === '/api/admin/tables/save' && request.method === 'POST') {
        const adminId = request.headers.get('x-admin-userid');
        const adminUser = await getAdminUser(env, adminId);
        if (!adminUser) {
          return jsonResponse({ success: false, error: 'Unauthorized admin access.' }, 403);
        }

        const body = await request.json().catch(() => ({}));
        const { table, data, isUpdate } = body;

        if (table === 'locations') {
          if (isUpdate) {
            await env.DB.prepare(
              `UPDATE locations SET description = ?, address = ? WHERE location_id = ?`
            ).bind(data.description, data.address, data.location_id).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO locations (location_id, description, address) VALUES (?, ?, ?)`
            ).bind(data.location_id.toUpperCase(), data.description, data.address).run();
          }
        } else if (table === 'cameras') {
          if (isUpdate) {
            await env.DB.prepare(
              `UPDATE cameras SET location_id = ?, name = ? WHERE camera_id = ?`
            ).bind(data.location_id.toUpperCase(), data.name, data.camera_id).run();
          } else {
            await env.DB.prepare(
              `INSERT INTO cameras (camera_id, location_id, name) VALUES (?, ?, ?)`
            ).bind(data.camera_id, data.location_id.toUpperCase(), data.name).run();
          }
        } else if (table === 'users') {
          let passwordHash = null;
          if (data.password && data.password.trim().length > 0) {
            passwordHash = await hashPassword(data.password.trim());
          }

          if (isUpdate) {
            if (passwordHash) {
              await env.DB.prepare(
                `UPDATE users SET role = ?, allowed_cameras = ?, password_hash = ? 
                 WHERE location_id = ? AND username = ?`
              ).bind(data.role, data.allowed_cameras, passwordHash, data.location_id, data.username).run();
            } else {
              await env.DB.prepare(
                `UPDATE users SET role = ?, allowed_cameras = ? 
                 WHERE location_id = ? AND username = ?`
              ).bind(data.role, data.allowed_cameras, data.location_id, data.username).run();
            }
          } else {
            const finalHash = passwordHash || await hashPassword('123');
            await env.DB.prepare(
              `INSERT INTO users (location_id, username, password_hash, role, allowed_cameras) 
               VALUES (?, ?, ?, ?, ?)`
            ).bind(data.location_id.toUpperCase(), data.username.toLowerCase(), finalHash, data.role, data.allowed_cameras).run();
          }
        } else {
          return jsonResponse({ success: false, error: 'Invalid table specified.' }, 400);
        }

        return jsonResponse({ success: true });
      }

      // ------------------------------------------------------------
      // 5. LIVE HLS STREAMING (/live/:file)
      // Reads directly from root: HQ-AD/<cam>.m3u8 or HQ-AD/<cam>_xxx.ts
      // ------------------------------------------------------------
      if (pathname.startsWith('/live/')) {
        let rawFile = pathname.replace(/^\/live\//, '');
        const location = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();

        if (!rawFile.includes('.')) {
          rawFile = `${rawFile}.m3u8`;
        }

        let r2Key = `${location}/${rawFile}`;
        let object = await env.MEDIA_BUCKET.get(r2Key);

        // Fallback for nested URLs (e.g. /live/apcam/stream.m3u8)
        if (!object && rawFile.includes('/')) {
          const strippedFilename = rawFile.split('/').pop();
          r2Key = `${location}/${strippedFilename}`;
          object = await env.MEDIA_BUCKET.get(r2Key);
        }

        if (!object) {
          return new Response(`Stream offline or segment not ready: ${r2Key}`, {
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
      // 6. SNAPSHOT RETRIEVAL (/api/snapshot/latest)
      // Reads from: HQ-AD/snapshots/<cam>/*.jpg
      // Supports: index=0..3 (for 2x2 quad view) and json=1 (metadata)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || 'HQ-AD').trim().toUpperCase();
        const rawCam = (url.searchParams.get('cam') || url.searchParams.get('camera') || 'apcam').trim().toLowerCase();
        const index = Math.max(0, parseInt(url.searchParams.get('index') || '0', 10));
        const isJson = url.searchParams.has('json');

        const prefix = `${rawLoc}/snapshots/${rawCam}/`;
        const list = await env.MEDIA_BUCKET.list({ prefix, limit: 60 });
        const images = (list.objects || []).filter(o => o.size > 0 && /\.(jpe?g|png|webp)$/i.test(o.key));

        if (images.length === 0) {
          if (isJson) {
            return jsonResponse({ error: 'No snapshots available', prefix }, 404);
          }
          return new Response(generatePlaceholderSvg(rawLoc, rawCam), {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Sort descending: index 0 is newest, index 1 is 2nd newest, etc.
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
      // 7. ON-DEMAND VIDEO REQUEST (/api/motion/request)
      // Drops a marker in R2 for the local Windows watcher to upload the MP4
      // ------------------------------------------------------------
      if (pathname === '/api/motion/request' && (request.method === 'POST' || request.method === 'GET')) {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cam = (url.searchParams.get('cam') || 'apcam').toLowerCase();
        let file = (url.searchParams.get('file') || '').trim();

        if (!file) {
          return jsonResponse({ error: 'Parameter "file" (e.g. 20261105_103010_motion.mp4) is required.' }, 400);
        }
        if (!file.endsWith('.mp4')) {
          file = `${file}.mp4`;
        }

        const videoKey = `${loc}/motion/${cam}/${file}`;

        // Return immediately if video is already available in R2
        const existing = await env.MEDIA_BUCKET.head(videoKey);
        if (existing) {
          return jsonResponse({
            status: 'ready',
            key: videoKey,
            playbackUrl: `/api/motion/latest?location=${loc}&cam=${cam}&file=${encodeURIComponent(file)}`
          });
        }

        // Drop .req marker in R2 for local watcher to pick up
        const markerKey = `${loc}/requests/${cam}__${file}.req`;
        await env.MEDIA_BUCKET.put(markerKey, new Uint8Array([1]), {
          httpMetadata: { contentType: 'application/json' }
        });

        return jsonResponse({
          status: 'pending',
          message: 'Video upload requested from local storage.',
          key: videoKey,
          marker: markerKey
        });
      }

      // ------------------------------------------------------------
      // 8. MOTION VIDEO STATUS CHECK (/api/motion/status)
      // Polled by frontend while waiting for the requested MP4 to upload
      // ------------------------------------------------------------
      if (pathname === '/api/motion/status' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cam = (url.searchParams.get('cam') || 'apcam').toLowerCase();
        let file = url.searchParams.get('file');

        if (!file) {
          return jsonResponse({ error: 'Parameter "file" is required.' }, 400);
        }
        if (!file.endsWith('.mp4')) {
          file = `${file}.mp4`;
        }

        const videoKey = `${loc}/motion/${cam}/${file}`;
        const existing = await env.MEDIA_BUCKET.head(videoKey);

        if (existing) {
          return jsonResponse({
            status: 'ready',
            size: existing.size,
            key: videoKey
          });
        }

        return jsonResponse({ status: 'transferring' });
      }

      // ------------------------------------------------------------
      // 9. MOTION VIDEO STREAMING (/api/motion/latest)
      // Serves requested .mp4 motion clip
      // ------------------------------------------------------------
      if (pathname === '/api/motion/latest' && request.method === 'GET') {
        const loc = (url.searchParams.get('location') || 'HQ-AD').toUpperCase();
        const cam = (url.searchParams.get('cam') || 'apcam').toLowerCase();
        const requestedFile = url.searchParams.get('file');
        const isJson = url.searchParams.has('json');

        let targetKey = null;

        if (requestedFile) {
          const cleanFile = requestedFile.endsWith('.mp4') ? requestedFile : `${requestedFile}.mp4`;
          targetKey = `${loc}/motion/${cam}/${cleanFile}`;
        } else {
          const prefix = `${loc}/motion/${cam}/`;
          const list = await env.MEDIA_BUCKET.list({ prefix, limit: 30 });
          const clips = (list.objects || []).filter(o => o.key.toLowerCase().endsWith('.mp4'));

          if (clips.length === 0) {
            return jsonResponse({ status: 'idle', message: 'No motion clips found', camera: cam }, 404);
          }

          clips.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
          targetKey = clips[0].key;
        }

        const videoObject = await env.MEDIA_BUCKET.get(targetKey);
        if (!videoObject) {
          return jsonResponse({ error: 'Video clip not ready or missing', key: targetKey }, 404);
        }

        if (isJson) {
          return jsonResponse({
            status: 'success',
            key: targetKey,
            size: videoObject.size,
            uploaded: videoObject.uploaded
          });
        }

        const headers = new Headers();
        headers.set('Content-Type', 'video/mp4');
        headers.set('Cache-Control', 'public, max-age=86400');
        headers.set('X-AISYS-Motion-Key', targetKey);
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(videoObject.body, { headers });
      }

      // ------------------------------------------------------------
      // 10. STATIC ASSETS & SINGLE-PAGE APP ROUTING
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
// HELPER FUNCTIONS
// ------------------------------------------------------------

async function getAdminUser(env, userId) {
  if (!userId) return null;
  return await env.DB.prepare(
    `SELECT user_id, role FROM users WHERE user_id = ? AND role = 'admin' LIMIT 1`
  ).bind(userId).first();
}

async function verifyPassword(inputPassword, storedHash) {
  if (!inputPassword || !storedHash) return false;
  if (storedHash === inputPassword) return true; // Direct plain text match support

  const encoder = new TextEncoder();
  const data = encoder.encode(inputPassword);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return storedHash.toLowerCase() === hashHex.toLowerCase();
}

async function hashPassword(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-userid'
    }
  });
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-userid',
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
