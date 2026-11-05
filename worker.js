export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === 'OPTIONS') {
      return handleCors();
    }

    try {
      // ------------------------------------------------------------
      // 1. AUTHENTICATION & LOGIN (/api/login or /api/auth/login)
      // ------------------------------------------------------------
      if ((pathname === '/api/login' || pathname === '/api/auth/login') && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const rawLoc = (body.locationId || body.locationCode || body.location || '').trim();
        const username = (body.username || body.operator || body.user || '').trim();
        const password = String(body.password || '').trim();

        if (!rawLoc || !username || !password) {
          return jsonResponse({ 
            status: 'error', 
            error: 'Location code, username, and password are required.' 
          }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const locFlipped = locUpper.includes('-') ? locUpper.split('-').reverse().join('-') : locUpper;

        // Query user from D1
        const user = await env.DB.prepare(
          `SELECT * FROM users 
           WHERE (UPPER(location_id) = ? OR UPPER(location_id) = ?) 
             AND LOWER(username) = LOWER(?) 
           LIMIT 1`
        ).bind(locUpper, locFlipped, username).first();

        if (!user) {
          return jsonResponse({ 
            status: 'error', 
            error: 'Invalid location or username.' 
          }, 401);
        }

        const isPasswordValid = await verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
          return jsonResponse({ 
            status: 'error', 
            error: 'Incorrect password.' 
          }, 401);
        }

        const actualLocId = user.location_id;

        // Facility details
        const locationMeta = await env.DB.prepare(
          `SELECT location_id, description, address FROM locations WHERE location_id = ?`
        ).bind(actualLocId).first() || { location_id: actualLocId, description: 'Active Facility' };

        // Facility cameras
        const cameraRecords = await env.DB.prepare(
          `SELECT camera_id, location_id, name FROM cameras WHERE location_id = ? ORDER BY camera_id ASC`
        ).bind(actualLocId).all();

        const allCameras = cameraRecords.results || [];

        // Camera permissions
        let allowedCameras = ['*'];
        try {
          allowedCameras = JSON.parse(user.allowed_cameras || '["*"]');
        } catch {
          allowedCameras = ['*'];
        }

        let authorizedCameras = allCameras;
        if (!allowedCameras.includes('*') && user.role !== 'admin') {
          const allowedLower = allowedCameras.map(a => String(a).toLowerCase());
          authorizedCameras = allCameras.filter(cam =>
            allowedLower.includes(String(cam.camera_id).toLowerCase()) ||
            allowedLower.includes((cam.name || '').toLowerCase())
          );
        }

        // Return status: 'success' to satisfy script.js line 70
        return jsonResponse({
          status: 'success',
          success: true,
          token: `session_${user.user_id}_${Date.now()}`,
          user: {
            userId: user.user_id,
            username: user.username,
            role: user.role,
            locationId: actualLocId,
            location: locationMeta,
            cameras: authorizedCameras
          }
        });
      }

      // ------------------------------------------------------------
      // 2. ADMIN EXPLORER: LOAD TABLES (/api/admin/tables)
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
      // 3. ADMIN EXPLORER: SAVE RECORD (/api/admin/tables/save)
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
      // 4. WAITLIST HANDLER (/api/waitlist)
      // ------------------------------------------------------------
      if (pathname === '/api/waitlist' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const email = String(body.email || '').trim();
        if (!email || !email.includes('@')) {
          return jsonResponse({ error: 'Valid email required.' }, 400);
        }
        return jsonResponse({ message: "You're on the list!" });
      }

      // ------------------------------------------------------------
      // 5. SNAPSHOT RETRIEVAL (/api/snapshot/latest)
      // ------------------------------------------------------------
      if (pathname === '/api/snapshot/latest' && request.method === 'GET') {
        const rawLoc = (url.searchParams.get('location') || '').trim();
        const rawCam = (url.searchParams.get('cam') || url.searchParams.get('camera') || '').trim();
        const isDebug = url.searchParams.has('debug');

        if (!rawLoc || !rawCam) {
          return jsonResponse({ error: 'Parameters "location" and "cam" are required.' }, 400);
        }

        const locUpper = rawLoc.toUpperCase();
        const camTargets = new Set([rawCam.toLowerCase(), rawCam.toUpperCase(), rawCam]);

        if (env.DB) {
          try {
            const camRow = await env.DB.prepare(
              `SELECT camera_id, name FROM cameras 
               WHERE (camera_id = ? OR LOWER(name) = LOWER(?))
                 AND UPPER(location_id) = ? 
               LIMIT 1`
            ).bind(rawCam, rawCam, locUpper).first();

            if (camRow) {
              if (camRow.name) {
                camTargets.add(camRow.name);
                camTargets.add(camRow.name.toLowerCase());
              }
              if (camRow.camera_id) {
                camTargets.add(String(camRow.camera_id));
              }
            }
          } catch (e) {}
        }

        const prefixSearches = [
          `${locUpper}/snapshots/`,
          `${rawLoc.toLowerCase()}/snapshots/`,
          `${locUpper}/SNAPSHOTS/`
        ];

        let allObjects = [];
        for (const p of prefixSearches) {
          const list = await env.MEDIA_BUCKET.list({ prefix: p, limit: 150 });
          if (list.objects && list.objects.length > 0) {
            allObjects.push(...list.objects);
          }
        }

        const uniqueObjects = Array.from(new Map(allObjects.map(obj => [obj.key, obj])).values());

        const validImages = uniqueObjects.filter(obj => 
          obj.size > 0 && /\.(jpe?g|png|webp)$/i.test(obj.key)
        );

        const candidates = validImages.filter(obj => {
          const keyLower = obj.key.toLowerCase();
          for (const target of camTargets) {
            const t = target.toLowerCase();
            if (
              keyLower.includes(`/${t}/`) ||
              keyLower.includes(`/${t}.`) ||
              keyLower.includes(`/${t}_`) ||
              keyLower.includes(`/${t}-`) ||
              keyLower.endsWith(`/${t}`) ||
              keyLower.includes(`snapshots/${t}`)
            ) {
              return true;
            }
          }
          return false;
        });

        if (isDebug) {
          return jsonResponse({
            status: 'diagnostic_mode',
            params: { location: rawLoc, cam: rawCam },
            searchedAliases: Array.from(camTargets),
            totalR2ObjectsFound: uniqueObjects.length,
            allR2Keys: uniqueObjects.map(o => ({ key: o.key, bytes: o.size, uploaded: o.uploaded })),
            matchedImageCount: candidates.length,
            matchedImages: candidates.map(o => ({ key: o.key, bytes: o.size, uploaded: o.uploaded }))
          });
        }

        if (candidates.length === 0) {
          return new Response(generatePlaceholderSvg(locUpper, rawCam), {
            status: 200,
            headers: {
              'Content-Type': 'image/svg+xml',
              'Cache-Control': 'no-cache, no-store, must-revalidate',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        candidates.sort((a, b) => new Date(b.uploaded).getTime() - new Date(a.uploaded).getTime());
        const latestKey = candidates[0].key;

        const object = await env.MEDIA_BUCKET.get(latestKey);
        if (!object) {
          return jsonResponse({ error: 'Object missing from storage' }, 404);
        }

        const headers = new Headers();
        headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
        headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        headers.set('ETag', object.httpEtag);
        headers.set('X-AISYS-Matched-Key', latestKey);
        headers.set('Access-Control-Allow-Origin', '*');

        return new Response(object.body, { headers });
      }

      // ------------------------------------------------------------
      // 6. STATIC SPA ROUTING
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
  if (storedHash === inputPassword) return true; // Plaintext support

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
