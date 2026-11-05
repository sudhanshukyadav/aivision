// ============================================================
// aisys-landing Worker — Multi-site industrial camera gateway
// ============================================================
const SESSION_TTL = 8 * 60 * 60; // 8 hours (seconds)
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const encoder = new TextEncoder();

// ── Crypto helpers ──────────────────────────────────────────

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, encoder.encode(data));
}

async function hmacHex(key, data) {
  return bufToHex(await hmac(key, data));
}

async function sha256Hex(data) {
  return bufToHex(await crypto.subtle.digest('SHA-256', encoder.encode(data)));
}

// ── Response helpers ────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function jsonError(status, message) {
  return json({ error: message }, status);
}

// ── R2 S3-compatible API via SigV4 ───────────────────────────

async function r2Get(bucketName, key, env, rangeHeader) {
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const path = `/${bucketName}/${key.split('/').map(encodeURIComponent).join('/')}`;

  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const date = timestamp.substring(0, 8);

  const headers = {
    host,
    'x-amz-date': timestamp,
    'x-amz-content-sha256': EMPTY_SHA256,
  };
  if (rangeHeader) headers.range = rangeHeader;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  const canonicalRequest = [ 'GET', path, '', canonicalHeaders, signedHeaders, EMPTY_SHA256 ].join('\n');

  const credentialScope = `${date}/auto/s3/aws4_request`;
  const stringToSign = [ 'AWS4-HMAC-SHA256', timestamp, credentialScope, await sha256Hex(canonicalRequest) ].join('\n');

  const kDate = await hmac(encoder.encode(`AWS4${env.R2_SECRET_ACCESS_KEY}`), date);
  const kRegion = await hmac(kDate, 'auto');
  const kService = await hmac(kRegion, 's3');
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = await hmacHex(kSigning, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const reqHeaders = { Host: host, 'x-amz-date': timestamp, Authorization: authorization };
  if (rangeHeader) reqHeaders.Range = rangeHeader;

  return fetch(`https://${host}${path}`, { method: 'GET', headers: reqHeaders });
}

// ── Session management ─────────────────────────────────────

async function createSession(env, data) {
  const token = crypto.randomUUID();
  await env.SESSIONS.put(token, JSON.stringify(data), { expirationTtl: SESSION_TTL });
  return token;
}

async function getSession(request, env) {
  const match = (request.headers.get('Cookie') || '').match(/aisys_session=([^;]+)/);
  if (!match) return null;
  const raw = await env.SESSIONS.get(match[1]);
  return raw ? JSON.parse(raw) : null;
}

function sessionCookie(token) {
  return `aisys_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie() {
  return `aisys_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// ── Access check ────────────────────────────────────────────

function findCamera(session, cameraId) {
  return session.cameras.find(c => c.id === cameraId);
}

// ── Handlers ────────────────────────────────────────────────

async function handleLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON'); }

  const { siteId, username, password } = body;
  if (!siteId || !username || !password) return jsonError(400, 'siteId, username, password required');

  const siteRaw = await env.SITES.get(`site:${siteId}`);
  if (!siteRaw) return jsonError(404, 'Unknown site');
  const site = JSON.parse(siteRaw);

  let authRes;
  try {
    authRes = await fetch(`${site.serverUrl}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    return jsonError(502, `Site server unreachable: ${e.message}`);
  }

  if (!authRes.ok) return jsonError(401, 'Invalid credentials');

  const auth = await authRes.json();
  if (!auth.accessLevel || !Array.isArray(auth.cameras)) return jsonError(502, 'Malformed auth response');

  const session = {
    siteId,
    username,
    accessLevel: auth.accessLevel,
    cameras: auth.cameras,
    serverUrl: site.serverUrl,
    bucketName: site.bucketName,
    createdAt: Date.now(),
  };
  const token = await createSession(env, session);

  return json({ ok: true, accessLevel: auth.accessLevel, cameras: auth.cameras }, 200, {
    'Set-Cookie': sessionCookie(token),
  });
}

async function handleLogout(request, env) {
  const match = (request.headers.get('Cookie') || '').match(/aisys_session=([^;]+)/);
  if (match) await env.SESSIONS.delete(match[1]);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}

function handleCameras(session) {
  return json({ cameras: session.cameras, accessLevel: session.accessLevel, siteId: session.siteId });
}

async function handleSnapshot(pathname, session, env) {
  const cameraId = pathname.split('/')[3];
  if (!findCamera(session, cameraId)) return jsonError(403, 'Camera not permitted');

  const key = `${cameraId}/snapshot.jpg`;
  const r2res = await r2Get(session.bucketName, key, env);
  if (r2res.status === 404) return jsonError(404, 'Snapshot not found');
  if (!r2res.ok) return jsonError(502, 'R2 read failed');

  return new Response(r2res.body, {
    status: 200,
    headers: { 'Content-Type': r2res.headers.get('Content-Type') || 'image/jpeg',
               'Cache-Control': 'no-cache' },
  });
}

async function handleClip(pathname, session, env, request) {
  const parts = pathname.split('/');
  const cameraId = parts[3];
  const clipId = parts[4];
  if (!findCamera(session, cameraId)) return jsonError(403, 'Camera not permitted');

  const key = `${cameraId}/clips/${clipId}.mp4`;
  const range = request.headers.get('Range');
  const r2res = await r2Get(session.bucketName, key, env, range || undefined);
  if (r2res.status === 404) return jsonError(404, 'Clip not found');
  if (!r2res.ok && r2res.status !== 206) return jsonError(502, 'R2 read failed');

  const respHeaders = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' };
  if (r2res.headers.get('Content-Range')) respHeaders['Content-Range'] = r2res.headers.get('Content-Range');
  if (r2res.headers.get('Content-Length')) respHeaders['Content-Length'] = r2res.headers.get('Content-Length');

  return new Response(r2res.body, { status: r2res.status, headers: respHeaders });
}

async function handleHls(pathname, session, env) {
  const parts = pathname.split('/');
  const cameraId = parts[3];
  const filename = parts.slice(4).join('/');
  if (!findCamera(session, cameraId)) return jsonError(403, 'Camera not permitted');

  const key = `${cameraId}/hls/${filename}`;
  const r2res = await r2Get(session.bucketName, key, env);
  if (r2res.status === 404) return jsonError(404, 'Segment not found');
  if (!r2res.ok) return jsonError(502, 'R2 read failed');

  const ext = filename.split('.').pop();
  const type = ext === 'm3u8' ? 'application/vnd.apple.mpegurl' : 'video/mp2t';
  return new Response(r2res.body, { status: 200, headers: { 'Content-Type': type } });
}

async function handleFeed(pathname, session, env) {
  const cameraId = pathname.split('/')[3];
  if (!findCamera(session, cameraId)) return jsonError(403, 'Camera not permitted');

  try {
    const upstream = await fetch(`${session.serverUrl}/feed/${cameraId}`);
    if (!upstream.ok) return jsonError(upstream.status, 'Feed server error');
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('Content-Type') || 'video/mp4' },
    });
  } catch (e) {
    return jsonError(502, `Feed server unreachable: ${e.message}`);
  }
}

// ── Admin: site registry ────────────────────────────────────

async function handleAdmin(request, env, url) {
  const auth = request.headers.get('Authorization');
  if (auth !== `Bearer ${env.ADMIN_KEY}`) return jsonError(401, 'Admin key required');

  const path = url.pathname;
  const method = request.method;

  if (path === '/admin/sites' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonError(400, 'Invalid JSON'); }
    const { siteId, serverUrl, bucketName, location } = body;
    if (!siteId || !serverUrl || !bucketName) return jsonError(400, 'siteId, serverUrl, bucketName required');
    await env.SITES.put(`site:${siteId}`, JSON.stringify({ serverUrl, bucketName, location: location || null }));
    return json({ ok: true, siteId });
  }

  if (path === '/admin/sites' && method === 'GET') {
    const list = await env.SITES.list({ prefix: 'site:' });
    const sites = [];
    for (const k of list.keys) {
      const raw = await env.SITES.get(k.name);
      if (raw) sites.push({ siteId: k.name.replace('site:', ''), ...JSON.parse(raw) });
    }
    return json({ sites });
  }

  if (path.startsWith('/admin/sites/') && method === 'DELETE') {
    const siteId = path.split('/').pop();
    await env.SITES.delete(`site:${siteId}`);
    return json({ ok: true });
  }

  return jsonError(404, 'Admin endpoint not found');
}

// ── Login page ──────────────────────────────────────────────

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AISYS Camera Portal</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#1e293b;padding:2.5rem;border-radius:12px;width:100%;max-width:380px;box-shadow:0 8px 32px rgba(0,0,0,.4)}
  h1{font-size:1.4rem;margin-bottom:.3rem}
  p.sub{color:#94a3b8;font-size:.85rem;margin-bottom:1.5rem}
  label{display:block;font-size:.8rem;color:#94a3b8;margin:.8rem 0 .3rem}
  input,select{width:100%;padding:.6rem .8rem;border:1px solid #334155;border-radius:6px;background:#0f172a;color:#e2e8f0;font-size:.9rem}
  button{width:100%;margin-top:1.5rem;padding:.7rem;border:none;border-radius:6px;background:#3b82f6;color:#fff;font-size:1rem;cursor:pointer}
  button:hover{background:#2563eb}
  .err{color:#ef4444;font-size:.8rem;margin-top:.8rem;min-height:1rem}
</style>
</head>
<body>
<div class="card">
  <h1>Industrial Camera Portal</h1>
  <p class="sub">Sign in to access your cameras</p>
  <form id="loginForm">
    <label for="siteId">Site</label>
    <select id="siteId" required><option value="">Loading sites…</option></select>
    <label for="username">Username</label>
    <input id="username" type="text" autocomplete="username" required>
    <label for="password">Password</label>
    <input id="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign In</button>
    <div class="err" id="err"></div>
  </form>
</div>
<script>
const err=document.getElementById('err');
const siteSel=document.getElementById('siteId');
fetch('/api/sites').then(r=>r.json()).then(d=>{
  siteSel.innerHTML=d.sites.map(s=>'<option value="'+s.siteId+'">'+s.siteId+(s.location?' — '+s.location:'')+'</option>').join('');
}).catch(()=>{siteSel.innerHTML='<option value="">Failed to load sites</option>';});
document.getElementById('loginForm').addEventListener('submit',async e=>{
  e.preventDefault();
  err.textContent='';
  const res=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    siteId:siteSel.value,username:document.getElementById('username').value,password:document.getElementById('password').value
  })});
  if(res.ok){window.location.href='/dashboard';}
  else{const d=await res.json().catch(()=>({}));err.textContent=d.error||'Login failed';}
});
</script>
</body>
</html>`;

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Camera Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
  .header{display:flex;justify-content:space-between;align-items:center;padding:1rem 2rem;background:#1e293b}
  .header h1{font-size:1.1rem}
  .header button{background:#334155;border:none;color:#e2e8f0;padding:.5rem 1rem;border-radius:6px;cursor:pointer}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem;padding:1.5rem}
  .cam{background:#1e293b;border-radius:8px;overflow:hidden}
  .cam img{width:100%;display:block;min-height:180px;background:#0f172a}
  .cam .bar{padding:.6rem .8rem;display:flex;justify-content:space-between;align-items:center}
  .cam .bar a{color:#3b82f6;text-decoration:none;font-size:.8rem}
  .cam .bar a.live{color:#ef4444}
</style>
</head>
<body>
<div class="header"><h1 id="title">Cameras</h1><button onclick="logout()">Sign Out</button></div>
<div class="grid" id="grid"></div>
<script>
async function init(){
  const res=await fetch('/api/cameras');
  if(!res.ok){window.location.href='/';return;}
  const data=await res.json();
  document.getElementById('title').textContent='Cameras — '+data.siteId+' ('+data.accessLevel+')';
  const grid=document.getElementById('grid');
  data.cameras.forEach(cam=>{
    const div=document.createElement('div');
    div.className='cam';
    div.innerHTML='<img src="/api/snapshot/'+cam.id+'" alt="'+cam.name+'">'+
      '<div class="bar"><span>'+cam.name+' ('+cam.location+')</span>'+
      '<a class="live" href="/api/feed/'+cam.id+'" target="_blank">Live</a></div>';
    grid.appendChild(div);
  });
}
async function logout(){await fetch('/api/logout',{method:'POST'});window.location.href='/';}
init();
</script>
</body>
</html>`;

// ── Public site list (IDs only, no server URLs) ────────────

async function handlePublicSites(env) {
  const list = await env.SITES.list({ prefix: 'site:' });
  const sites = [];
  for (const k of list.keys) {
    const raw = await env.SITES.get(k.name);
    if (raw) {
      const s = JSON.parse(raw);
      sites.push({ siteId: k.name.replace('site:', ''), location: s.location || null });
    }
  }
  return json({ sites });
}

// ── Main router ─────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      }});
    }

    if ((path === '/' || path === '/login') && method === 'GET')
      return new Response(LOGIN_HTML, { headers: { 'Content-Type': 'text/html' } });

    if (path === '/dashboard' && method === 'GET')
      return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html' } });

    if (path === '/api/sites' && method === 'GET') return handlePublicSites(env);

    if (path.startsWith('/admin/')) return handleAdmin(request, env, url);

    if (path === '/api/login' && method === 'POST') return handleLogin(request, env);
    if (path === '/api/logout' && method === 'POST') return handleLogout(request, env);

    const session = await getSession(request, env);
    if (!session) return jsonError(401, 'Not authenticated');

    if (path === '/api/cameras' && method === 'GET') return handleCameras(session);

    if (path.startsWith('/api/snapshot/') && method === 'GET') return handleSnapshot(path, session, env);
    if (path.startsWith('/api/clip/') && method === 'GET') return handleClip(path, session, env, request);
    if (path.startsWith('/api/hls/') && method === 'GET') return handleHls(path, session, env);
    if (path.startsWith('/api/feed/') && method === 'GET') return handleFeed(path, session, env);

    return jsonError(404, 'Not found');
  },
};