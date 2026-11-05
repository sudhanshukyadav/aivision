// ============================================================
// AISYS Live Camera Dashboard (4-Snapshot Quad View)
// ============================================================

const POLL_INTERVAL_MS = 2500; // Poll for near real-time snapshots every 2.5s
let activePollTimer = null;
let currentSession = null;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

function initDashboard() {
  const sessionRaw = localStorage.getItem('aisys_session');
  if (!sessionRaw) {
    window.location.href = '/login.html';
    return;
  }

  try {
    currentSession = JSON.parse(sessionRaw);
  } catch (e) {
    window.location.href = '/login.html';
    return;
  }

  const locationId = currentSession.locationId || 'HQ-AD';
  const cameras = currentSession.cameras || [{ camera_id: 'apcam', name: 'AP Camera' }];

  renderCameraGrid(locationId, cameras);
  startSnapshotPolling(locationId, cameras);
}

// ------------------------------------------------------------
// RENDER CAMERA CONTAINERS
// ------------------------------------------------------------
function renderCameraGrid(locationId, cameras) {
  const container = document.getElementById('camera-grid') || document.querySelector('.camera-container');
  if (!container) return;

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
          <button class="live-stream-btn" onclick="toggleLiveHls('${locationId}', '${camId}')">
            Watch Live Feed
          </button>
        </div>

        <!-- 4-Snapshot Quad View (Fills allocated container) -->
        <div class="camera-quad-grid" id="quad-${camId}">
          ${[0, 1, 2, 3].map(idx => `
            <div class="quad-item quad-item-${idx}" onclick="handleSnapshotClick('${locationId}', '${camId}', ${idx})">
              <img 
                id="snap-${camId}-${idx}" 
                src="/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${idx}&t=${Date.now()}" 
                alt="${camName} Snapshot ${idx + 1}"
                loading="eager"
              />
              <div class="quad-badge">${idx === 0 ? 'Live Stills' : `#${idx + 1}`}</div>
              <div class="quad-play-overlay">
                <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                  <path d="M8 5v14l11-7z"/>
                </svg>
                <span>Play Clip</span>
              </div>
            </div>
          `).join('')}
        </div>

        <!-- Video Player Modal Container (Hidden by default) -->
        <div class="video-container" id="video-wrap-${camId}" style="display: none;">
          <video id="player-${camId}" controls playsinline preload="none"></video>
          <button class="close-video-btn" onclick="closeVideoPlayer('${camId}')">&times;</button>
        </div>
      </div>
    `;
  }).join('');
}

// ------------------------------------------------------------
// NEAR REAL-TIME POLLING FOR LATEST SNAPSHOTS
// ------------------------------------------------------------
function startSnapshotPolling(locationId, cameras) {
  if (activePollTimer) clearInterval(activePollTimer);

  activePollTimer = setInterval(() => {
    const timestamp = Date.now();
    cameras.forEach(cam => {
      const camId = (cam.camera_id || cam.name || 'apcam').toLowerCase();
      
      // Update each of the 4 snapshot quadrants with cache-busting timestamp
      for (let idx = 0; idx < 4; idx++) {
        const img = document.getElementById(`snap-${camId}-${idx}`);
        if (img) {
          const nextSrc = `/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${idx}&t=${timestamp}`;
          // Preload to eliminate flicker
          const preload = new Image();
          preload.src = nextSrc;
          preload.onload = () => { img.src = nextSrc; };
        }
      }
    });
  }, POLL_INTERVAL_MS);
}

// ------------------------------------------------------------
// ON-DEMAND VIDEO CLIP RETRIEVAL ON SNAPSHOT CLICK
// ------------------------------------------------------------
async function handleSnapshotClick(locationId, camId, index) {
  const statusBadge = document.querySelector(`#cam-card-${camId} .quad-badge`);
  if (statusBadge) statusBadge.innerText = 'Requesting Clip...';

  try {
    // 1. Fetch metadata of the clicked snapshot to get its filename
    const metaRes = await fetch(`/api/snapshot/latest?cam=${camId}&location=${locationId}&index=${index}&json=1`);
    const meta = await metaRes.json();

    if (!meta || !meta.key) {
      alert('Snapshot key unavailable.');
      return;
    }

    // Convert snapshot name to matching motion clip filename (e.g. 20261105_103000.mp4)
    const baseName = meta.key.split('/').pop().replace(/\.(jpe?g|png)$/i, '');
    const mp4Name = `${baseName}_motion.mp4`;

    // 2. Notify Cloudflare and the local Windows watcher to pull the 10s video
    const reqRes = await fetch(`/api/motion/request?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`);
    const reqData = await reqRes.json();

    pollMotionReady(locationId, camId, mp4Name);

  } catch (err) {
    console.error('Failed to request motion video:', err);
    if (statusBadge) statusBadge.innerText = 'Error';
  }
}

// Polls until the Windows watcher completes transferring the 10s MP4 to R2
function pollMotionReady(locationId, camId, mp4Name) {
  let attempts = 0;
  const poll = setInterval(async () => {
    attempts++;
    try {
      const res = await fetch(`/api/motion/status?location=${locationId}&cam=${camId}&file=${encodeURIComponent(mp4Name)}`);
      const data = await res.json();

      if (data.status === 'ready' || attempts >= 8) {
        clearInterval(poll);
        playMotionVideo(camId, `/api/motion/latest?location=${locationId}&cam=${camId}&t=${Date.now()}`);
      }
    } catch (e) {
      clearInterval(poll);
    }
  }, 1000);
}

function playMotionVideo(camId, videoUrl) {
  const quadGrid = document.getElementById(`quad-${camId}`);
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const player = document.getElementById(`player-${camId}`);

  if (quadGrid && videoWrap && player) {
    quadGrid.style.display = 'none';
    videoWrap.style.display = 'block';
    player.src = videoUrl;
    player.play().catch(() => {});
  }
}

function closeVideoPlayer(camId) {
  const quadGrid = document.getElementById(`quad-${camId}`);
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const player = document.getElementById(`player-${camId}`);

  if (quadGrid && videoWrap && player) {
    player.pause();
    player.src = '';
    videoWrap.style.display = 'none';
    quadGrid.style.display = 'grid';
  }
}

function toggleLiveHls(locationId, camId) {
  const videoWrap = document.getElementById(`video-wrap-${camId}`);
  const quadGrid = document.getElementById(`quad-${camId}`);
  const player = document.getElementById(`player-${camId}`);
  const hlsUrl = `/live/${camId}.m3u8?location=${locationId}`;

  if (videoWrap.style.display === 'block') {
    closeVideoPlayer(camId);
    return;
  }

  quadGrid.style.display = 'none';
  videoWrap.style.display = 'block';

  if (player.canPlayType('application/vnd.apple.mpegurl')) {
    player.src = hlsUrl;
    player.play().catch(() => {});
  } else if (window.Hls && Hls.isSupported()) {
    const hls = new Hls();
    hls.loadSource(hlsUrl);
    hls.attachMedia(player);
    hls.on(Hls.Events.MANIFEST_PARSED, () => player.play());
  } else {
    alert('Live stream HLS not supported on this browser.');
  }
}
