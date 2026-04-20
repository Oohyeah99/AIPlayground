/**
 * app.js — Main app: tab navigation, status bar polling, model picker population
 */
(async function () {
  // --- Tab Navigation ---
  const navBtns = document.querySelectorAll('.nav-btn');
  const tabPanels = document.querySelectorAll('.tab-panel');

  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      navBtns.forEach(b => b.classList.remove('active'));
      tabPanels.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + tab).classList.add('active');
    });
  });

  // --- Status Bar Polling ---
  const $ollamaStatus = document.querySelector('#ollama-status .status-dot');
  const $comfyuiStatus = document.querySelector('#comfyui-status .status-dot');
  const $vramFill = document.querySelector('.vram-bar .vram-fill');
  const $vramText = document.querySelector('.vram-bar .vram-text');

  async function pollStatus() {
    // Ollama
    try {
      const res = await fetch('/ollama/api/tags', { signal: AbortSignal.timeout(5000) });
      $ollamaStatus.className = 'status-dot ' + (res.ok ? 'online' : 'offline');
    } catch {
      $ollamaStatus.className = 'status-dot offline';
    }

    // ComfyUI
    try {
      const status = await API.comfyuiStatus();
      $comfyuiStatus.className = 'status-dot ' + (status.online ? 'online' : 'offline');
      if (status.online && status.vram_total) {
        const freeGb = (status.vram_free || 0) / (1024 ** 3);
        const totalGb = (status.vram_total || 0) / (1024 ** 3);
        const usedGb = totalGb - freeGb;
        const pct = (usedGb / totalGb * 100);
        $vramFill.style.width = pct + '%';
        $vramText.textContent = `${usedGb.toFixed(1)}/${totalGb.toFixed(0)} GB`;
      }
    } catch {
      $comfyuiStatus.className = 'status-dot offline';
    }
  }

  // --- Populate model selector ---
  async function populateModelSelect() {
    const $select = document.getElementById('chat-model-select');
    try {
      const data = await API.ollamaTags();
      const models = data.models || [];
      $select.innerHTML = models.map(m => {
        const size = m.details?.parameter_size || '';
        return `<option value="${m.name}">${m.name}${size ? ' (' + size + ')' : ''}</option>`;
      }).join('');

      // Default to gemma4 if available
      const gemma = models.find(m => m.name.startsWith('gemma4'));
      if (gemma) $select.value = gemma.name;
    } catch {
      $select.innerHTML = '<option value="">Ollama offline</option>';
    }
  }

  // --- Lightbox ---
  document.getElementById('lightbox-close').addEventListener('click', () => {
    document.getElementById('lightbox').classList.add('hidden');
  });
  document.getElementById('lightbox').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('lightbox').classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.getElementById('lightbox').classList.add('hidden');
    }
  });

  // --- Init all modules ---
  await populateModelSelect();
  pollStatus();
  setInterval(pollStatus, 15000);

  Chat.init();
  ImageGen.init();
  VideoGen.init();
  Models.init();
})();
