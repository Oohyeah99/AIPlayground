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
  const $btnFreeVram = document.getElementById('btn-vram-free');

  // --- Free VRAM button ---
  $btnFreeVram.addEventListener('click', async () => {
    $btnFreeVram.disabled = true;
    $btnFreeVram.textContent = 'Freeing...';
    try {
      await API.comfyuiFreeMemory();
      $btnFreeVram.textContent = 'Freed';
      $btnFreeVram.classList.add('freed');
      // Immediately refresh VRAM display
      await pollStatus();
      setTimeout(() => {
        $btnFreeVram.textContent = 'Free VRAM';
        $btnFreeVram.classList.remove('freed');
        $btnFreeVram.disabled = false;
      }, 3000);
    } catch (err) {
      $btnFreeVram.textContent = 'Error';
      setTimeout(() => {
        $btnFreeVram.textContent = 'Free VRAM';
        $btnFreeVram.disabled = false;
      }, 2000);
    }
  });

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

  // --- Populate model selector (grouped by provider) ---
  let _providersCache = null;

  async function populateModelSelect() {
    const $select = document.getElementById('chat-model-select');
    try {
      const data = await API.getProviders('aiplayground');
      _providersCache = data.providers;

      $select.innerHTML = '';
      let defaultValue = '';

      for (const prov of data.providers) {
        if (!prov.models.length && prov.status === 'offline') continue;
        const group = document.createElement('optgroup');
        const statusIcon = prov.status === 'online' ? '● ' : prov.status === 'ready' ? '' : '○ ';
        group.label = statusIcon + prov.name;

        for (const m of prov.models) {
          const opt = document.createElement('option');
          opt.value = prov.id + '/' + m.id;
          opt.textContent = m.name + (m.size ? ` (${m.size})` : '');
          if (prov.status === 'no_key') opt.disabled = true;
          group.appendChild(opt);
        }
        $select.appendChild(group);

        // Default to gemma4 if available
        if (prov.id === 'ollama' && !defaultValue) {
          const gemma = prov.models.find(m => m.id.startsWith('gemma4'));
          if (gemma) defaultValue = prov.id + '/' + gemma.id;
          else if (prov.models.length) defaultValue = prov.id + '/' + prov.models[0].id;
        }
      }

      if (defaultValue) $select.value = defaultValue;
    } catch {
      $select.innerHTML = '<option value="">No providers available</option>';
    }
  }

  /** Returns the cached providers list (for Compare module) */
  window.getProvidersCache = () => _providersCache;

  // --- Lightbox (shared by Image, Video, Audio tabs) ---
  const _lb = document.getElementById('lightbox');
  const _lbMedia = document.getElementById('lightbox-media');
  const _lbPrompt = document.getElementById('lightbox-prompt');
  const _lbMeta = document.getElementById('lightbox-meta');
  const _lbCopy = document.getElementById('lightbox-copy');
  const _lbUse = document.getElementById('lightbox-use');
  let _lbUseCallback = null;
  let _lbCurrentPrompt = '';

  window.Lightbox = {
    /**
     * Open lightbox. opts: { mediaHtml, prompt, meta, onUsePrompt(prompt) }
     */
    open(opts) {
      _lbMedia.innerHTML = opts.mediaHtml || '';
      _lbPrompt.textContent = opts.prompt || '';
      _lbMeta.textContent = opts.meta || '';
      _lbCurrentPrompt = opts.prompt || '';
      _lbUseCallback = opts.onUsePrompt || null;
      _lb.classList.remove('hidden');
    },
    close() {
      _lb.classList.add('hidden');
      _lbMedia.innerHTML = '';
    }
  };

  document.getElementById('lightbox-close').addEventListener('click', Lightbox.close);
  _lb.addEventListener('click', (e) => { if (e.target === _lb) Lightbox.close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') Lightbox.close(); });

  _lbCopy.addEventListener('click', () => {
    if (_lbCurrentPrompt) {
      navigator.clipboard.writeText(_lbCurrentPrompt).then(() => {
        _lbCopy.textContent = 'Copied!';
        setTimeout(() => { _lbCopy.textContent = 'Copy Prompt'; }, 1500);
      });
    }
  });

  _lbUse.addEventListener('click', () => {
    if (_lbCurrentPrompt && _lbUseCallback) {
      _lbUseCallback(_lbCurrentPrompt);
      Lightbox.close();
    }
  });

  // --- Init all modules ---
  await populateModelSelect();
  pollStatus();
  setInterval(pollStatus, 15000);

  Chat.init();
  ImageGen.init();
  VideoGen.init();
  TTS.init();
  Compare.init();
  Settings.init();
})();
