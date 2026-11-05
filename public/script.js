document.addEventListener('DOMContentLoaded', () => {
  let currentUserSession = null;
  let cachedTables = {};
  let currentActiveTable = 'locations';

  // --- Modal & Navigation Elements ---
  const securityBtn = document.getElementById('securityBtn');
  const securityModal = document.getElementById('securityModal');
  const modalClose = document.getElementById('modalClose');

  const loginForm = document.getElementById('loginForm');
  const loginErr = document.getElementById('loginErr');
  const loginSubmitBtn = document.getElementById('loginSubmitBtn');

  // --- Admin Explorer Elements ---
  const adminModal = document.getElementById('adminModal');
  const adminModalClose = document.getElementById('adminModalClose');
  const adminDataTable = document.getElementById('adminDataTable');
  const recordDrawer = document.getElementById('recordDrawer');
  const recordForm = document.getElementById('recordForm');
  const recordFormFields = document.getElementById('recordFormFields');
  const drawerTitle = document.getElementById('drawerTitle');
  const addRowBtn = document.getElementById('addRowBtn');
  const cancelDrawerBtn = document.getElementById('cancelDrawerBtn');
  const refreshTablesBtn = document.getElementById('refreshTablesBtn');

  // --- Optional Landing Page Elements ---
  const waitlistForm = document.getElementById('waitlistForm');
  const waitlistEmail = document.getElementById('waitlistEmail');
  const waitlistSubmitBtn = document.getElementById('waitlistSubmitBtn');
  const waitlistMsg = document.getElementById('waitlistMsg');

  // --- 1. MODAL OPEN / CLOSE CONTROLS ---

  if (securityBtn && securityModal) {
    securityBtn.addEventListener('click', (e) => {
      e.preventDefault();
      securityModal.classList.add('open');
      if (loginErr) loginErr.textContent = '';
    });
  }

  if (modalClose && securityModal) {
    modalClose.addEventListener('click', () => {
      securityModal.classList.remove('open');
    });
  }

  if (adminModalClose && adminModal) {
    adminModalClose.addEventListener('click', () => {
      adminModal.classList.remove('open');
    });
  }

  // Close modals when clicking outside the box
  window.addEventListener('click', (e) => {
    if (securityModal && e.target === securityModal) securityModal.classList.remove('open');
    if (adminModal && e.target === adminModal) adminModal.classList.remove('open');
  });

  // Close modals on Escape key
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (securityModal) securityModal.classList.remove('open');
      if (adminModal) adminModal.classList.remove('open');
    }
  });

  // --- 2. AUTHENTICATION & LOGIN HANDLER ---

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (loginErr) loginErr.textContent = '';
      if (loginSubmitBtn) {
        loginSubmitBtn.disabled = true;
        loginSubmitBtn.textContent = 'Authenticating...';
      }

      const payload = {
        locationId: document.getElementById('locationId').value.trim().toUpperCase(),
        username: document.getElementById('username').value.trim().toLowerCase(),
        password: document.getElementById('password').value
      };

      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (res.ok && data.status === 'success') {
          currentUserSession = data.user;
          sessionStorage.setItem('aisys_session', JSON.stringify(data.user));

          if (securityModal) securityModal.classList.remove('open');

          // Direct Admin to full Database Explorer; direct viewers/operators to Live stream
          if (data.user.role === 'admin') {
            openAdminExplorer();
          } else {
            window.location.href = '/live.html';
          }
        } else {
          const detailMsg = data.details ? ` (${data.details})` : '';
          if (loginErr) loginErr.textContent = (data.error || 'Authentication failed.') + detailMsg;
        }
      } catch (err) {
        if (loginErr) loginErr.textContent = 'Network or connection error: ' + (err.message || String(err));
      } finally {
        if (loginSubmitBtn) {
          loginSubmitBtn.disabled = false;
          loginSubmitBtn.textContent = 'Authenticate';
        }
      }
    });
  }

  // --- 3. ADMIN EXPLORER CONTROLLER ---

  async function openAdminExplorer() {
    if (!adminModal) return;
    adminModal.classList.add('open');
    await loadAdminTables();
  }

  async function loadAdminTables() {
    if (!currentUserSession?.userId) return;
    try {
      const res = await fetch('/api/admin/tables', {
        headers: { 'x-admin-userid': currentUserSession.userId }
      });
      const result = await res.json();
      if (result.success) {
        cachedTables = result.tables;
        renderCurrentTable();
      } else {
        alert(result.error || 'Failed to load database tables.');
      }
    } catch (err) {
      alert('Error fetching tables: ' + (err.message || String(err)));
    }
  }

  function renderCurrentTable() {
    if (!adminDataTable) return;
    const thead = adminDataTable.querySelector('thead');
    const tbody = adminDataTable.querySelector('tbody');
    thead.innerHTML = '';
    tbody.innerHTML = '';

    const rows = cachedTables[currentActiveTable] || [];
    if (rows.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding: 2rem;">No records in ${currentActiveTable}</td></tr>`;
      return;
    }

    const columns = Object.keys(rows[0]);
    thead.innerHTML = `<tr>${columns.map(c => `<th>${c}</th>`).join('')}<th>Actions</th></tr>`;

    tbody.innerHTML = rows.map((row, idx) => `
      <tr>
        ${columns.map(c => `<td>${escapeHtml(String(row[c] ?? ''))}</td>`).join('')}
        <td><button type="button" class="table-edit-btn" data-index="${idx}">Edit</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.table-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => openEditor(rows[btn.dataset.index]));
    });
  }

  // Tab switching (Locations / Cameras / Users)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentActiveTable = btn.dataset.table;
      if (recordDrawer) recordDrawer.classList.add('hidden');
      renderCurrentTable();
    });
  });

  // Drawer Form Setup (Insert / Edit)
  function openEditor(record = null) {
    if (!recordDrawer || !recordForm || !recordFormFields) return;
    recordDrawer.classList.remove('hidden');
    if (drawerTitle) {
      drawerTitle.textContent = record ? `Update ${currentActiveTable} Record` : `Append to ${currentActiveTable}`;
    }
    recordForm.dataset.isUpdate = record ? 'true' : 'false';

    let fields = [];
    if (currentActiveTable === 'locations') {
      fields = [
        { name: 'location_id', label: 'Location ID (e.g. HQ-01)', val: record?.location_id || '', readOnly: !!record },
        { name: 'description', label: 'Description', val: record?.description || '' },
        { name: 'address', label: 'Address', val: record?.address || '' }
      ];
    } else if (currentActiveTable === 'cameras') {
      fields = [
        { name: 'camera_id', label: 'Camera ID (e.g. CAM-01)', val: record?.camera_id || '', readOnly: !!record },
        { name: 'location_id', label: 'Location ID (e.g. HQ-01)', val: record?.location_id || currentUserSession.locationId || '' },
        { name: 'name', label: 'Camera Name', val: record?.name || '' }
      ];
    } else if (currentActiveTable === 'users') {
      fields = [
        { name: 'location_id', label: 'Location ID', val: record?.location_id || '', readOnly: !!record },
        { name: 'username', label: 'Username', val: record?.username || '', readOnly: !!record },
        { name: 'role', label: 'Role (admin / superuser / operator / viewer)', val: record?.role || 'viewer' },
        { name: 'allowed_cameras', label: 'Allowed Cameras (JSON array e.g. ["CAM-01"] or ["*"])', val: record?.allowed_cameras || '[]' },
        { name: 'password', label: record ? 'Change Password (leave blank to keep current)' : 'Password', val: '', isPassword: true }
      ];
    }

    recordFormFields.innerHTML = fields.map(f => `
      <div class="form-group">
        <label>${f.label}</label>
        <input 
          type="${f.isPassword ? 'password' : 'text'}" 
          name="${f.name}" 
          value="${escapeHtml(f.val)}" 
          ${f.readOnly ? 'readonly style="opacity:0.6"' : (f.isPassword && record ? '' : 'required')} 
        />
      </div>
    `).join('');
  }

  if (addRowBtn) {
    addRowBtn.addEventListener('click', () => openEditor(null));
  }

  if (cancelDrawerBtn && recordDrawer) {
    cancelDrawerBtn.addEventListener('click', () => recordDrawer.classList.add('hidden'));
  }

  if (refreshTablesBtn) {
    refreshTablesBtn.addEventListener('click', loadAdminTables);
  }

  // Admin Save Submission
  if (recordForm) {
    recordForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(recordForm);
      const dataObj = {};
      formData.forEach((val, key) => { dataObj[key] = val; });

      const isUpdate = recordForm.dataset.isUpdate === 'true';

      try {
        const res = await fetch('/api/admin/tables/save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-userid': currentUserSession.userId
          },
          body: JSON.stringify({
            table: currentActiveTable,
            data: dataObj,
            isUpdate
          })
        });

        const result = await res.json();
        if (result.success) {
          if (recordDrawer) recordDrawer.classList.add('hidden');
          await loadAdminTables();
        } else {
          alert(result.error || 'Failed to save record.');
        }
      } catch (err) {
        alert('Request failed: ' + (err.message || String(err)));
      }
    });
  }

  // --- 4. OPTIONAL WAITLIST HANDLER ---

  if (waitlistForm) {
    waitlistForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (waitlistSubmitBtn) waitlistSubmitBtn.disabled = true;
      if (waitlistMsg) {
        waitlistMsg.textContent = 'Submitting...';
        waitlistMsg.style.color = '#38bdf8';
      }

      try {
        const res = await fetch('/api/waitlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: waitlistEmail.value })
        });
        const data = await res.json();
        if (res.ok) {
          if (waitlistMsg) {
            waitlistMsg.textContent = data.message || "You're on the list!";
            waitlistMsg.style.color = '#4ade80';
          }
          if (waitlistEmail) waitlistEmail.value = '';
        } else {
          if (waitlistMsg) {
            waitlistMsg.textContent = data.error || 'Failed to submit.';
            waitlistMsg.style.color = '#f87171';
          }
        }
      } catch {
        if (waitlistMsg) {
          waitlistMsg.textContent = 'Network error.';
          waitlistMsg.style.color = '#f87171';
        }
      } finally {
        if (waitlistSubmitBtn) waitlistSubmitBtn.disabled = false;
      }
    });
  }

  // --- UTILITIES ---

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
});