<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Camera Snapshot History</title>
  <style>
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      background: #090d16;
      color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .top-bar {
      height: 52px;
      background: #0f172a;
      border-bottom: 1px solid #1e293b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      position: sticky;
      top: 0;
      z-index: 50;
    }
    .bar-left {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .cam-title {
      font-size: 16px;
      font-weight: 700;
      color: #f8fafc;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .site-full-name {
      font-size: 12px;
      color: #38bdf8;
      background: #1e293b;
      padding: 3px 10px;
      border-radius: 4px;
      border: 1px solid #334155;
      font-weight: 500;
    }
    .back-btn-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      background: #1e293b;
      color: #38bdf8;
      border: 1px solid #334155;
      border-radius: 6px;
      font-size: 16px;
      text-decoration: none;
      font-weight: bold;
      transition: background 0.2s, color 0.2s;
    }
    .back-btn-icon:hover {
      background: #334155;
      color: #f8fafc;
    }

    .bar-right {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .filter-btn {
      background: #1e293b;
      color: #f8fafc;
      border: 1px solid #334155;
      padding: 5px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .filter-btn:hover { background: #334155; border-color: #38bdf8; }
    .filter-btn.active { background: #0284c7; border-color: #38bdf8; color: #fff; }
    .count-badge { font-size: 12px; color: #94a3b8; font-family: monospace; }

    .filter-popover {
      display: none;
      position: absolute;
      top: 58px;
      right: 16px;
      background: #151c2e;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.7);
      z-index: 60;
      flex-direction: column;
      gap: 8px;
    }
    .filter-popover input[type="date"] {
      background: #0b0f19;
      color: #f8fafc;
      border: 1px solid #334155;
      border-radius: 4px;
      padding: 5px 8px;
      font-size: 13px;
      color-scheme: dark;
    }
    .filter-popover-actions { display: flex; gap: 6px; margin-top: 4px; }
    .pop-btn { flex: 1; padding: 5px; font-size: 11px; font-weight: 600; border-radius: 4px; border: none; cursor: pointer; }
    .pop-btn-apply { background: #0284c7; color: #fff; }
    .pop-btn-clear { background: #334155; color: #94a3b8; }

    .gallery-container {
      flex: 1;
      padding: 12px;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
      gap: 10px;
      align-content: start;
    }
    .thumb-card {
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 6px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      cursor: pointer;
      transition: transform 0.15s ease, border-color 0.15s ease;
    }
    .thumb-card:hover { transform: translateY(-2px); border-color: #38bdf8; }
    .thumb-wrapper { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #030712; overflow: hidden; }
    .thumb-wrapper img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .thumb-info {
      padding: 6px 8px;
      background: #0f172a;
      border-top: 1px solid #1e293b;
      display: flex;
      align-items: center;
      justify-content: space-between;
      white-space: nowrap;
    }
    .info-timestamp { font-size: 11px; font-family: monospace; color: #e2e8f0; }
    .info-timestamp .time-part { color: #38bdf8; margin-left: 4px; }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(3, 7, 18, 0.95);
      z-index: 100;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .modal-close {
      position: absolute;
      top: 16px;
      right: 20px;
      background: #1e293b;
      color: #fff;
      border: 1px solid #334155;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      font-size: 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-image { max-width: 90vw; max-height: 75vh; border-radius: 6px; border: 1px solid #334155; object-fit: contain; }
    .modal-bar { margin-top: 14px; display: flex; align-items: center; gap: 16px; }
    .modal-timestamp { font-size: 14px; color: #f8fafc; font-family: monospace; }
    .modal-play-btn {
      background: #0284c7;
      color: #fff;
      border: none;
      padding: 7px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .modal-play-btn:hover { background: #0369a1; }
    .modal-video-wrap {
      display: none;
      width: 90vw;
      max-width: 1080px;
      max-height: 75vh;
      background: #000;
      border-radius: 6px;
      overflow: hidden;
      border: 1px solid #334155;
    }
    .modal-video-wrap video { width: 100%; height: 100%; max-height: 75vh; display: block; }
    .empty-state { grid-column: 1 / -1; text-align: center; color: #64748b; margin-top: 80px; font-size: 14px; }
  </style>
</head>
<body>

  <header class="top-bar">
    <div class="bar-left">
      <span class="cam-title" id="cam-header-title">CAMERA</span>
      <span class="site-full-name" id="site-header-name">Loading Site…</span>
      <a href="/live.html" class="back-btn-icon" title="Return to Live Grid">&larr;</a>
    </div>

    <div class="bar-right">
      <button class="filter-btn" id="toggle-filter-btn" onclick="toggleDateFilterPopover()">
        <span id="filter-btn-label">Filter Date</span>
      </button>

      <div class="filter-popover" id="date-filter-popover">
        <label for="filter-date-input" style="font-size: 11px; color:#94a3b8; font-weight:600;">SELECT DATE</label>
        <input type="date" id="filter-date-input">
        <div class="filter-popover-actions">
          <button class="pop-btn pop-btn-apply" onclick="applyDateFilter()">Apply</button>
          <button class="pop-btn pop-btn-clear" onclick="clearDateFilter()">Clear</button>
        </div>
      </div>

      <div class="count-badge" id="snap-count">--</div>
    </div>
  </header>

  <main class="gallery-container" id="gallery-grid"></main>

  <div class="modal-overlay" id="viewer-modal">
    <button class="modal-close" onclick="closeModal()">&times;</button>
    <img id="modal-img" class="modal-image" src="" alt="Snapshot" />
    <div class="modal-video-wrap" id="modal-vid-wrap">
      <video id="modal-vid-player" controls playsinline></video>
    </div>
    <div class="modal-bar">
      <span class="modal-timestamp" id="modal-time-label"></span>
      <button class="modal-play-btn" id="modal-play-action" onclick="fetchAndPlayMotion()">
        Play 10s Motion Clip
      </button>
    </div>
  </div>

  <script>
    const params = new URLSearchParams(window.location.search);
    const sessionRaw = localStorage.getItem('aisys_session');
    let session = {};
    try { session = sessionRaw ? JSON.parse(sessionRaw) : {}; } catch (e) {}

    const LOCATION_CODE = (params.get('location') || session.locationId || 'HQ-AD').toUpperCase();
    const CAMERA = (params.get('cam') || 'apcam').toLowerCase();

    let allSnapshots = [];
    let currentFilterDate = null;
    let currentSelectedSnap = null;

    document.addEventListener('DOMContentLoaded', async () => {
      document.getElementById('cam-header-title').textContent = CAMERA.toUpperCase();
      await resolveSiteDescription();
      await loadCameraSnapshots();
    });

    async function resolveSiteDescription() {
      const siteBadge = document.getElementById('site-header-name');
      if (session.location && session.location.description) {
        siteBadge.textContent = session.location.description;
        return;
      }
      try {
        const res = await fetch('/api/sites');
        if (res.ok) {
          const data = await res.json();
          const match = (data.sites || []).find(s => s.locationId.toUpperCase() === LOCATION_CODE);
          if (match && match.label) {
            siteBadge.textContent = match.label.includes('—') ? match.label.split('—')[1].trim() : match.label;
            return;
          }
        }
      } catch (e) {}
      siteBadge.textContent = LOCATION_CODE;
    }

    function formatDateTime(d) {
      const pad = n => String(n).padStart(2, '0');
      return {
        dateStr: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`,
        timeStr: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
        singleLine: `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      };
    }

    async function loadCameraSnapshots() {
      try {
        const res = await fetch(`/api/snapshots/list?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}`);
        const data = await res.json();
        allSnapshots = data.snapshots || [];
        renderSnapshotsGrid();
      } catch (err) {
        document.getElementById('gallery-grid').innerHTML = `<div class="empty-state">Failed to connect to storage: ${err.message}</div>`;
      }
    }

    function renderSnapshotsGrid() {
      const grid = document.getElementById('gallery-grid');
      let filtered = allSnapshots;
      if (currentFilterDate) {
        filtered = allSnapshots.filter(s => formatDateTime(new Date(s.uploaded)).dateStr === currentFilterDate);
      }

      document.getElementById('snap-count').textContent = `${filtered.length} Snaps`;

      if (filtered.length === 0) {
        grid.innerHTML = `<div class="empty-state">No snapshots found for this date.</div>`;
        return;
      }

      grid.innerHTML = filtered.map((s, idx) => {
        const dt = formatDateTime(new Date(s.uploaded));
        const imgUrl = `/api/snapshot/latest?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}&index=${idx}`;

        return `
          <div class="thumb-card" onclick="openModal('${s.filename}', '${s.uploaded}', ${idx})">
            <div class="thumb-wrapper">
              <img src="${imgUrl}" alt="${s.filename}" loading="lazy" />
            </div>
            <div class="thumb-info">
              <span class="info-timestamp">${dt.dateStr}<span class="time-part">${dt.timeStr}</span></span>
            </div>
          </div>
        `;
      }).join('');
    }

    function toggleDateFilterPopover() {
      const popover = document.getElementById('date-filter-popover');
      popover.style.display = popover.style.display === 'flex' ? 'none' : 'flex';
    }

    function applyDateFilter() {
      const val = document.getElementById('filter-date-input').value;
      if (!val) return;
      currentFilterDate = val;
      document.getElementById('filter-btn-label').textContent = val;
      document.getElementById('toggle-filter-btn').classList.add('active');
      toggleDateFilterPopover();
      renderSnapshotsGrid();
    }

    function clearDateFilter() {
      document.getElementById('filter-date-input').value = '';
      currentFilterDate = null;
      document.getElementById('filter-btn-label').textContent = 'Filter Date';
      document.getElementById('toggle-filter-btn').classList.remove('active');
      toggleDateFilterPopover();
      renderSnapshotsGrid();
    }

    function openModal(filename, uploadedStr, index) {
      currentSelectedSnap = { filename, uploadedStr, index };
      const dt = formatDateTime(new Date(uploadedStr));

      document.getElementById('modal-img').style.display = 'block';
      document.getElementById('modal-vid-wrap').style.display = 'none';
      
      const playBtn = document.getElementById('modal-play-action');
      playBtn.style.display = 'flex';
      playBtn.textContent = 'Play 10s Motion Clip';
      playBtn.disabled = false;

      document.getElementById('modal-img').src = `/api/snapshot/latest?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}&index=${index}`;
      document.getElementById('modal-time-label').textContent = dt.singleLine;
      document.getElementById('viewer-modal').style.display = 'flex';
    }

    // CHECK BEFORE PLAY (Option B)
    async function fetchAndPlayMotion() {
      if (!currentSelectedSnap) return;

      const baseName = currentSelectedSnap.filename.replace(/\.(jpe?g|png|webp)$/i, '');
      const mp4File = `${baseName}_motion.mp4`;
      const playBtn = document.getElementById('modal-play-action');
      
      playBtn.disabled = true;
      playBtn.textContent = 'Checking cloud cache…';

      try {
        const checkRes = await fetch(`/api/motion/check?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}&file=${encodeURIComponent(mp4File)}`);
        const statusData = await checkRes.json();

        // 1. If already stored in R2, stream immediately
        if (statusData.status === 'ready') {
          startPlayback(mp4File);
          return;
        }

        // 2. Not in R2: Poll until r2_watcher finishes uploading the file
        playBtn.textContent = 'Fetching from camera disk…';
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          const retryRes = await fetch(`/api/motion/check?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}&file=${encodeURIComponent(mp4File)}`);
          const checkAgain = await retryRes.json();

          if (checkAgain.status === 'ready') {
            clearInterval(poll);
            startPlayback(mp4File);
          } else if (attempts > 15) {
            clearInterval(poll);
            playBtn.textContent = 'File not found on local disk';
          }
        }, 1500);

      } catch (err) {
        playBtn.textContent = 'Connection error';
        playBtn.disabled = false;
      }
    }

    function startPlayback(mp4File) {
      const modalImg = document.getElementById('modal-img');
      const vidWrap = document.getElementById('modal-vid-wrap');
      const vidPlayer = document.getElementById('modal-vid-player');
      const playBtn = document.getElementById('modal-play-action');

      modalImg.style.display = 'none';
      playBtn.style.display = 'none';
      vidWrap.style.display = 'block';

      vidPlayer.src = `/api/motion/latest?location=${LOCATION_CODE}&cam=${encodeURIComponent(CAMERA)}&file=${encodeURIComponent(mp4File)}`;
      vidPlayer.muted = true;
      vidPlayer.play().catch(() => {});
    }

    function closeModal() {
      const vidPlayer = document.getElementById('modal-vid-player');
      if (vidPlayer) {
        vidPlayer.pause();
        vidPlayer.removeAttribute('src');
      }
      document.getElementById('viewer-modal').style.display = 'none';
    }

    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  </script>
</body>
</html>
