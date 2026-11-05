(function () {
  function initLive() {
    const sessionRaw = sessionStorage.getItem('aisys_session');
    if (!sessionRaw) {
      console.warn('[AISYS] No session found. Redirecting to login...');
      window.location.href = '/';
      return;
    }

    let user;
    try {
      user = JSON.parse(sessionRaw);
    } catch (e) {
      console.error('[AISYS] Corrupted session JSON:', e);
      sessionStorage.removeItem('aisys_session');
      window.location.href = '/';
      return;
    }

    const locationBadge = document.getElementById('locationBadge');
    const userPill = document.getElementById('userPill');
    const cameraGrid = document.getElementById('cameraGrid');
    const logoutBtn = document.getElementById('logoutBtn');
    const btnModeSnapshots = document.getElementById('btnModeSnapshots');
    const btnModeLive = document.getElementById('btnModeLive');

    // Update Header Info
    if (locationBadge) {
      locationBadge.textContent = `${user.locationId || 'LOC'} — ${user.location?.description || 'Active Facility'}`;
    }
    if (userPill) {
      userPill.textContent = `${user.username || 'User'} (${user.role || 'viewer'})`;
    }

    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        sessionStorage.removeItem('aisys_session');
        window.location.href = '/';
      });
    }

    const cameras = user.cameras || [];
    if (cameras.length === 0) {
      if (cameraGrid) {
        cameraGrid.innerHTML = `
          <div class="no-cams-alert">
            <h3>No Authorized Cameras</h3>
            <p>No video channels have been assigned to your profile for location ${escapeHtml(user.locationId || '')}.</p>
          </div>
        `;
      }
      return;
    }

    let currentMode = 'snapshots';
    let activeHlsInstances = [];
    let snapshotInterval = null;

    // Set default grid columns
    if (cameras.length > 4) setGrid(3);
    else if (cameras.length > 1) setGrid(2);
    else setGrid(1);

    // Initial render
    renderView();

    if (btnModeSnapshots) {
      btnModeSnapshots.addEventListener('click', () => {
        if (currentMode === 'snapshots') return;
        currentMode = 'snapshots';
        btnModeSnapshots.classList.add('active');
        if (btnModeLive) btnModeLive.classList.remove('active');
        renderView();
      });
    }

    if (btnModeLive) {
      btnModeLive.addEventListener('click', () => {
        if (currentMode === 'live') return;
        currentMode = 'live';
        btnModeLive.classList.add('active');
        if (btnModeSnapshots) btnModeSnapshots.classList.remove('active');
        renderView();
      });
    }

    function renderView() {
      // Clean up previous video instances and intervals
      activeHlsInstances.forEach(hls => { try { hls.destroy(); } catch {} });
      activeHlsInstances = [];
      if (snapshotInterval) {
        clearInterval(snapshotInterval);
        snapshotInterval = null;
      }

      if (!cameraGrid) return;
      cameraGrid.innerHTML = '';

      cameras.forEach((cam, index) => {
        const tile = document.createElement('div');
        tile.className = 'camera-tile';
        tile.id = `tile-${cam.camera_id}`;

        tile.innerHTML = `
          <div class="camera-tile-header">
            <span class="cam-status-dot ${currentMode === 'snapshots' ? 'snapshot-dot' : ''}"></span>
            <span class="cam-name">${escapeHtml(cam.name || cam.camera_id)} (${escapeHtml(cam.camera_id)})</span>
            <span class="cam-mode-tag">${currentMode === 'snapshots' ? 'Snapshot' : 'Live'}</span>
            <button type="button" class="fullscreen-tile-btn" title="Toggle Fullscreen">⛶</button>
          </div>
          <div class="video-container" id="media-box-${index}"></div>
        `;

        cameraGrid.appendChild(tile);

        const box = tile.querySelector(`#media-box-${index}`);

        if (currentMode === 'snapshots') {
          const img = document.createElement('img');
          img.className = 'snapshot-img';
          img.alt = `${cam.name} Snapshot`;
          // Requests snapshot using camera name
          img.src = `/api/snapshot/latest?location=${encodeURIComponent(user.locationId)}&cam=${encodeURIComponent(cam.name || cam.camera_id)}&_t=${Date.now()}`;
          img.style.cursor = 'pointer';
          img.title = 'Click to switch to live feed';
          img.addEventListener('click', () => {
            if (btnModeLive) btnModeLive.click();
          });
          box.appendChild(img);
        } else {
          const video = document.createElement('video');
          video.playsInline = true;
          video.autoplay = true;
          video.muted = true;
          box.appendChild(video);

          const streamUrl = `https://stream.aisys.cam/${user.locationId}/live/${cam.name}/index.m3u8`;
          mountHlsPlayer(video, streamUrl);
        }

        const fsBtn = tile.querySelector('.fullscreen-tile-btn');
        if (fsBtn) {
          fsBtn.addEventListener('click', () => {
            if (!document.fullscreenElement) tile.requestFullscreen().catch(() => {});
            else document.exitFullscreen().catch(() => {});
          });
        }
      });

      // Poll snapshots every 5 seconds
      if (currentMode === 'snapshots') {
        snapshotInterval = setInterval(() => {
          cameras.forEach((cam, index) => {
            const img = document.querySelector(`#media-box-${index} .snapshot-img`);
            if (img) {
              img.src = `/api/snapshot/latest?location=${encodeURIComponent(user.locationId)}&cam=${encodeURIComponent(cam.name || cam.camera_id)}&_t=${Date.now()}`;
            }
          });
        }, 5000);
      }
    }

    function mountHlsPlayer(videoElement, hlsUrl) {
      if (typeof Hls !== 'undefined' && Hls.isSupported()) {
        const hls = new Hls({
          lowLatencyMode: true,
          backBufferLength: 0,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 4
        });
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoElement);
        hls.on(Hls.Events.MANIFEST_PARSED, () => videoElement.play().catch(() => {}));
        activeHlsInstances.push(hls);
      } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        videoElement.src = hlsUrl;
        videoElement.play().catch(() => {});
      }
    }

    document.querySelectorAll('.grid-btn').forEach(btn => {
      btn.addEventListener('click', () => setGrid(parseInt(btn.dataset.grid, 10)));
    });

    function setGrid(columns) {
      if (!cameraGrid) return;
      cameraGrid.className = `camera-grid grid-${columns}`;
      document.querySelectorAll('.grid-btn').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.grid, 10) === columns);
      });
    }
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLive);
  } else {
    initLive();
  }
})();
