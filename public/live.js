// ============================================================
// AISYS Live Camera Dashboard (4-Snapshot Quad View & Live HLS)
// ============================================================

const POLL_INTERVAL_MS = 2500; // Poll for fresh snapshots every 2.5s
let activePollTimer = null;
let activeHlsInstances = {};

// ------------------------------------------------------------
// 1. IMMUTABLE SESSION ENFORCEMENT & INITIALIZATION
// ------------------------------------------------------------
const sessionRaw = localStorage.getItem('aisys_session');
if (!sessionRaw) {
  window.location.replace('/login.html');
}

let sessionData;
try {
  sessionData = JSON.parse(sessionRaw);
  if (!sessionData.locationId || !sessionData.username || !sessionData.token) {
    throw new Error('Incomplete session credentials');
  }
} catch (e) {
  localStorage.removeItem('aisys_session');
  window.location.replace('/login.html');
}

// Sealed, unalterable credentials for the current page session
const LOCKED_LOCATION_ID = sessionData.locationId;
const LOCKED_USERNAME = sessionData.username;
const LOCKED_ROLE = sessionData.role || 'viewer';
const LOCKED_CAMERAS = sessionData.cameras || [];

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

function initDashboard() {
  updateUserHeader();
  renderCameraGrid(LOCKED_LOCATION_ID, LOCKED_CAMERAS);
  startSnapshotPolling(LOCKED_LOCATION_ID, LOCKED_CAMERAS);
}

function updateUserHeader() {
  const userDisplay = document.getElementById('user-display') || document.querySelector('.user-info');
  if (userDisplay) {
    userDisplay.textContent = `${LOCKED_USERNAME} @ ${LOCKED_LOCATION_ID} (${LOCKED_ROLE.toUpperCase()})`;
  }
}

// ------------------------------------------------------------
// 2. RENDER CAMERA CARDS (2x2 Quad View per Camera)
// ------------------------------------------------------------
function renderCameraGrid(locationId, cameras) {
  const container = document.getElementById('camera-grid') || document.querySelector('.camera-container');
  if (!container) return;

  if (cameras.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; color: #94a3b8; padding: 3rem;">
        No cameras authorized for user ${LOCKED_USERNAME} at site ${locationId}.
      </div>
    `;
    return;
  }

  container.innerHTML = cameras.map(cam => {
    const camId = (cam.camera_id || cam.name || 'apcam').toLowerCase();
    const camName = cam.name || cam.camera_id || 'Camera';

    return `
      <div class="camera-card" id="cam-card-${camId}">
        <div class="camera-header">
          <div class="camera-title-wrap">
            <span class="live-dot pulse"></span>
            <span class="camera-name">${camName}</span>
            <span class="camera-tag">${locationId}</span>
          </div>
          <button class="live-stream-btn" id="stream-btn-${camId}" onclick="toggleLiveHls('${locationId}', '${camId}')">
            Watch Live Stream
          </button>
        </div>

        <!-- 4-Snapshot Quad Grid (Zoomed in to fill display) -->
        <div class="camera-quad-grid" id="quad-${camId}">
          ${[0, 1, 2, 3].map(idx => `
            <div class="quad-item quad-item-${idx}" onclick="handleSnapshotClick('${locationId}', '${camId}', ${idx})">
              <img 
                id="snap-${camId}-${idx}" 
                src="/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${idx}&t=${Date.now()}" 
                alt="${camName} Snapshot ${idx + 1}"
                loading="eager"
              />
              <div class="quad-badge">${idx === 0 ? 'Live (Latest)' : `#${idx + 1}`}</div>
              <div class="quad-play-overlay">
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Play 10s Clip</span>
              </div>
            </div>
          `).join('')}
        </div>

        <!-- In-Place Video Player Container (Hidden by default) -->
        <div class="video-container" id="video-wrap-${camId}" style="display: none;">
          <video id="player-${camId}" controls playsinline preload="none"></video>
          <button class="close-video-btn" title="Close Video" onclick="closeVideoPlayer('${camId}')">&times;</button>
          <div class="video-status-overlay" id="status-overlay-${camId}" style="display: none;"></div>
        </div>
      </div>
    `;
  }).join('');
}

// ------------------------------------------------------------
// 3. BACKGROUND SNAPSHOT POLLER (Flicker-Free Preloading)
// ------------------------------------------------------------
function startSnapshotPolling(locationId, cameras) {
  if (activePollTimer) clearInterval(activePollTimer);

  activePollTimer = setInterval(() => {
    const timestamp = Date.now();
    cameras.forEach(cam => {
      const camId = (cam.camera_id || cam.name || 'apcam').toLowerCase();
      const videoWrap = document.getElementById(`video-wrap-${camId}`);

      // Pause snapshot updates while video player/live stream is open on this card
      if (videoWrap && videoWrap.style.display === 'block') {
        return;
      }

      for (let idx = 0; idx < 4; idx++) {
        const img = document.getElementById(`snap-${camId}-${idx}`);
        if (img) {
          const nextSrc = `/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${idx}&t=${timestamp}`;
          const preloadImg = new Image();
          preloadImg.src = nextSrc;
          preloadImg.onload = () => {
            img.src = nextSrc;
          };
        }
      }
    });
  }, POLL_INTERVAL_MS);
}

// ------------------------------------------------------------
// 4. ON-DEMAND MOTION CLIP RETRIEVAL (Triggered on Click)
// ------------------------------------------------------------
async function handleSnapshotClick(locationId, camId, index) {
  const quadGrid = document.getElementById(`quad-${camId}`);
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const player = document.getElementById(`player-${camId}`);
  const overlay = document.getElementById(`status-overlay-${camId}`);

  // Switch view to player container immediately and display status
  quadGrid.style.display = 'none';
  videoWrap.style.display = 'block';
  overlay.style.display = 'flex';
  overlay.textContent = 'Locating motion recording...';

  try {
    // 1. Fetch metadata for the clicked snapshot to get its filename
    const metaRes = await fetch(`/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${index}&json=1`);
    if (!metaRes.ok) throw new Error('Snapshot metadata unavailable');
    
    const meta = await metaRes.json();
    const rawKey = meta.key || '';
    const filenameWithExt = rawKey.split('/').pop();
    const baseName = filenameWithExt.replace(/\.(jpe?g|png|webp)$/i, '');
    
    // Derive corresponding 10s MP4 filename
    const mp4Name = `${baseName}_motion.mp4`;

    overlay.textContent = 'Requesting clip from camera storage...';

    // 2. Instruct edge worker to place a .req marker for local r2_watcher.py
    const reqRes = await fetch(`/api/motion/request?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`);
    const reqData = await reqRes.json();

    if (reqData.status === 'ready') {
      overlay.style.display = 'none';
      player.src = `/api/motion/latest?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`;
      player.play().catch(() => {});
      return;
    }

    // 3. Poll /api/motion/status until local watcher completes S3 transfer
    pollMotionTransferStatus(locationId, camId, mp4Name);

  } catch (err) {
    console.error('Motion fetch error:', err);
    overlay.textContent = 'Motion clip unavailable for this snapshot.';
    setTimeout(() => {
      closeVideoPlayer(camId);
    }, 2500);
  }
}

function pollMotionTransferStatus(locationId, camId, mp4Name) {
  const player = document.getElementById(`player-${camId}`);
  const overlay = document.getElementById(`status-overlay-${camId}`);
  let pollAttempts = 0;
  const maxAttempts = 12; // 12 seconds max timeout

  const pollInterval = setInterval(async () => {
    pollAttempts++;
    overlay.textContent = `Transferring motion video... (${pollAttempts}s)`;

    try {
      const res = await fetch(`/api/motion/status?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`);
      const data = await res.json();

      if (data.status === 'ready') {
        clearInterval(pollInterval);
        overlay.style.display = 'none';
        player.src = `/api/motion/latest?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`;
        player.play().catch(() => {});
      } else if (pollAttempts >= maxAttempts) {
        clearInterval(pollInterval);
        overlay.textContent = 'Upload timed out. File remains local.';
        setTimeout(() => closeVideoPlayer(camId), 2500);
      }
    } catch (e) {
      clearInterval(pollInterval);
      overlay.textContent = 'Transfer check failed.';
      setTimeout(() => closeVideoPlayer(camId), 2500);
    }
  }, 1000);
}

// ------------------------------------------------------------
// 5. LIVE HLS STREAMING CONTROLLER
// ------------------------------------------------------------
function toggleLiveHls(locationId, camId) {
  const quadGrid = document.getElementById(`quad-${camId}`);
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const player = document.getElementById(`player-${camId}`);
  const streamBtn = document.getElementById(`stream-btn-${camId}`);
  const overlay = document.getElementById(`status-overlay-${camId}`);

  // If already open, close and return to 4-snapshot quad view
  if (videoWrap.style.display === 'block') {
    closeVideoPlayer(camId);
    return;
  }

  quadGrid.style.display = 'none';
  videoWrap.style.display = 'block';
  overlay.style.display = 'none';
  if (streamBtn) streamBtn.textContent = 'Return to Snapshots';

  const hlsUrl = `/live/${camId}.m3u8?location=${locationId}`;

  // Native Safari / iOS HLS support
  if (player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = hlsUrl;
    player.play().catch(() => {
      overlay.style.display = 'flex';
      overlay.textContent = 'Stream offline or chunk not ready.';
    });
  } 
  // Hls.js fallback for Chrome, Edge, Firefox
  else if (window.Hls && Hls.isSupported()) {
    if (activeHlsInstances[camId]) {
      activeHlsInstances[camId].destroy();
    }
    const hls = new Hls({ enableWorker: true, lowLatencyMode: true });
    hls.loadSource(hlsUrl);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      player.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (event, data) => {
      if (data.fatal) {
        overlay.style.display = 'flex';
        overlay.textContent = 'Live stream offline.';
      }
    });
    activeHlsInstances[camId] = hls;
  } else {
    alert('HLS playback is not supported by your browser.');
    closeVideoPlayer(camId);
  }
}

// ------------------------------------------------------------
// 6. CLOSE VIDEO PLAYER / RETURN TO QUAD GRID
// ------------------------------------------------------------
function closeVideoPlayer(camId) {
  const quadGrid = document.getElementById(`quad-${camId}`);
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const player = document.getElementById(`player-${camId}`);
  const streamBtn = document.getElementById(`stream-btn-${camId}`);
  const overlay = document.getElementById(`status-overlay-${camId}`);

  if (player) {
    player.pause();
    player.src = '';
  }

  if (activeHlsInstances[camId]) {
    activeHlsInstances[camId].destroy();
    delete activeHlsInstances[camId];
  }

  if (streamBtn) {
    streamBtn.textContent = 'Watch Live Stream';
  }

  if (overlay) {
    overlay.style.display = 'none';
  }

  if (videoWrap) videoWrap.style.display = 'none';
  if (quadGrid) quadGrid.style.display = 'grid';
}

// ------------------------------------------------------------
// 7. USER LOGOUT
// ------------------------------------------------------------
function logout() {
  if (activePollTimer) clearInterval(activePollTimer);
  localStorage.removeItem('aisys_session');
  window.location.replace('/login.html');
}
