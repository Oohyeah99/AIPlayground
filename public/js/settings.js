/**
 * settings.js — Settings tab: sub-tab navigation, GPU status, Ollama models,
 * API model discovery, and per-app model availability matrix.
 */
const Settings = (() => {
  // --- App list for availability matrix ---
  const APPS = [
    { id: 'aiplayground', name: 'AI Playground' },
    { id: 'vocabvista', name: 'VocabVista' },
    { id: 'littlereader', name: 'LittleReader' },
    { id: 'englishprep', name: 'EnglishPrep' },
    { id: 'zhongkaoprep', name: 'ZhongkaoPrep' },
  ];

  // --- DOM refs (GPU) ---
  const $gpuName = document.getElementById('gpu-name');
  const $gpuVramFill = document.getElementById('gpu-vram-fill');
  const $gpuVramText = document.getElementById('gpu-vram-text');
  const $gpuComfyui = document.getElementById('gpu-comfyui-version');
  const $gpuLoaded = document.getElementById('gpu-loaded-models');

  // --- DOM refs (Ollama) ---
  const $modelsBody = document.getElementById('models-table-body');
  const $comfyuiModels = document.getElementById('comfyui-models-list');
  const $pullInput = document.getElementById('pull-model-name');
  const $btnPull = document.getElementById('btn-pull-model');
  const $pullProgress = document.getElementById('pull-progress');
  const $pullFill = document.getElementById('pull-progress-fill');
  const $pullText = document.getElementById('pull-progress-text');

  // --- DOM refs (API Models) ---
  const $btnDiscover = document.getElementById('btn-discover-models');
  const $discoverStatus = document.getElementById('discover-status');
  const $openaiList = document.getElementById('api-openai-list');
  const $geminiList = document.getElementById('api-gemini-list');
  const $deepseekList = document.getElementById('api-deepseek-list');
  const $openaiCount = document.getElementById('openai-model-count');
  const $geminiCount = document.getElementById('gemini-model-count');
  const $deepseekCount = document.getElementById('deepseek-model-count');

  // --- DOM refs (Availability) ---
  const $matrixBody = document.getElementById('availability-matrix-body');
  const $btnSave = document.getElementById('btn-save-availability');

  // ===================== GPU =====================

  function formatSize(bytes) {
    if (!bytes) return '--';
    const gb = bytes / (1024 ** 3);
    return gb >= 1 ? gb.toFixed(1) + ' GB' : (bytes / (1024 ** 2)).toFixed(0) + ' MB';
  }

  async function refreshGpuStatus() {
    const status = await API.comfyuiStatus();
    if (status.online) {
      $gpuName.textContent = status.gpu || 'Unknown GPU';
      const freeGb = (status.vram_free || 0) / (1024 ** 3);
      const totalGb = (status.vram_total || 0) / (1024 ** 3);
      const usedGb = totalGb - freeGb;
      const pct = totalGb > 0 ? (usedGb / totalGb * 100) : 0;
      $gpuVramFill.style.width = pct + '%';
      $gpuVramText.textContent = `${usedGb.toFixed(1)} / ${totalGb.toFixed(1)} GB`;
      $gpuComfyui.textContent = status.version || '--';
    } else {
      $gpuName.textContent = 'Offline';
      $gpuVramText.textContent = '-- / -- GB';
      $gpuComfyui.textContent = 'Offline';
    }

    try {
      const ps = await API.ollamaPs();
      const loaded = (ps.models || []).map(m => m.name).join(', ');
      $gpuLoaded.textContent = loaded || 'None';
    } catch {
      $gpuLoaded.textContent = 'Unknown';
    }
  }

  // ===================== Ollama Models =====================

  async function refreshModelList() {
    try {
      const data = await API.ollamaTags();
      const models = data.models || [];
      if (!models.length) {
        $modelsBody.innerHTML = '<tr><td colspan="5" class="table-empty">No models installed</td></tr>';
        return models;
      }

      $modelsBody.innerHTML = models.map(m => {
        const d = m.details || {};
        return `<tr>
          <td>${m.name}</td>
          <td>${formatSize(m.size)}</td>
          <td>${d.parameter_size || '--'}</td>
          <td>${d.quantization_level || '--'}</td>
          <td><button class="btn btn-danger btn-sm btn-delete-model" data-name="${m.name}">Delete</button></td>
        </tr>`;
      }).join('');

      $modelsBody.querySelectorAll('.btn-delete-model').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          if (!confirm(`Delete model "${name}"?`)) return;
          btn.disabled = true;
          btn.textContent = '...';
          try {
            await API.ollamaDelete(name);
            await refreshModelList();
          } catch (err) {
            alert('Delete failed: ' + err.message);
            btn.disabled = false;
            btn.textContent = 'Delete';
          }
        });
      });

      return models;
    } catch (err) {
      $modelsBody.innerHTML = `<tr><td colspan="5" class="table-empty">Error: ${err.message}</td></tr>`;
      return [];
    }
  }

  async function refreshComfyuiModels() {
    try {
      const models = await API.comfyuiModels();
      $comfyuiModels.innerHTML = Object.entries(models).map(([folder, files]) => {
        if (!files.length) return '';
        return `<div class="comfyui-model-group">
          <h4>${folder.replace(/_/g, ' ')}</h4>
          <ul>${files.map(f => `<li>${f}</li>`).join('')}</ul>
        </div>`;
      }).join('') || '<div style="color:var(--text-muted)">No models found</div>';
    } catch {
      $comfyuiModels.innerHTML = '<div style="color:var(--text-muted)">ComfyUI offline</div>';
    }
  }

  async function pullModel() {
    const name = $pullInput.value.trim();
    if (!name) return;

    $btnPull.disabled = true;
    $pullProgress.classList.remove('hidden');
    $pullText.textContent = 'Starting download...';
    $pullFill.style.width = '0%';

    try {
      await API.ollamaPull(name, (data) => {
        if (data.total && data.completed) {
          const pct = Math.round(data.completed / data.total * 100);
          $pullFill.style.width = pct + '%';
          $pullText.textContent = `Downloading... ${pct}%`;
        } else if (data.status) {
          $pullText.textContent = data.status;
        }
      });
      $pullText.textContent = 'Done!';
      $pullInput.value = '';
      await refreshModelList();
      setTimeout(() => $pullProgress.classList.add('hidden'), 2000);
    } catch (err) {
      $pullText.textContent = `Error: ${err.message}`;
      setTimeout(() => $pullProgress.classList.add('hidden'), 3000);
    } finally {
      $btnPull.disabled = false;
    }
  }

  // ===================== API Models Discovery =====================

  async function discoverModels(force) {
    $btnDiscover.disabled = true;
    $btnDiscover.textContent = 'Checking...';
    $discoverStatus.textContent = 'Fetching models from APIs...';

    try {
      const data = await API.discoverModels(force);

      // Render OpenAI
      if (data.openai.length) {
        $openaiList.innerHTML = data.openai
          .map(m => `<span class="api-model-tag" title="${m.owned_by || ''}">${m.id}</span>`)
          .join('');
        $openaiCount.textContent = `(${data.openai.length} models)`;
      } else {
        $openaiList.innerHTML = '<span class="text-muted">No models found (check API key)</span>';
        $openaiCount.textContent = '';
      }

      // Render Gemini
      if (data.gemini.length) {
        $geminiList.innerHTML = data.gemini
          .map(m => `<span class="api-model-tag" title="${m.description || ''}">${m.id}</span>`)
          .join('');
        $geminiCount.textContent = `(${data.gemini.length} models)`;
      } else {
        $geminiList.innerHTML = '<span class="text-muted">No models found (check API key)</span>';
        $geminiCount.textContent = '';
      }

      // Render DeepSeek
      if (data.deepseek && data.deepseek.length) {
        $deepseekList.innerHTML = data.deepseek
          .map(m => `<span class="api-model-tag" title="${m.owned_by || ''}">${m.id}</span>`)
          .join('');
        $deepseekCount.textContent = `(${data.deepseek.length} models)`;
      } else {
        $deepseekList.innerHTML = '<span class="text-muted">No models found (check API key)</span>';
        $deepseekCount.textContent = '';
      }

      const ts = data.discovered_at ? new Date(data.discovered_at).toLocaleString() : 'just now';
      $discoverStatus.textContent = `Last checked: ${ts}`;
    } catch (err) {
      $discoverStatus.textContent = `Error: ${err.message}`;
    } finally {
      $btnDiscover.disabled = false;
      $btnDiscover.textContent = 'Check Latest Models';
    }
  }

  // ===================== Availability Matrix =====================

  let _registry = null;
  let _allModels = []; // [{provider, id, name}]

  async function loadAvailabilityMatrix() {
    $matrixBody.innerHTML = '<tr><td colspan="6" class="table-empty">Loading...</td></tr>';

    try {
      // Fetch registry + all models in parallel
      const [registry, providers] = await Promise.all([
        API.getRegistry(),
        API.getProviders(),
      ]);

      _registry = registry;
      const globalHidden = new Set(registry.global_hidden || []);
      const overrides = registry.app_overrides || {};

      // Build flat model list from providers
      _allModels = [];
      for (const prov of providers.providers) {
        for (const m of prov.models) {
          _allModels.push({ provider: prov.id, id: m.id, name: m.name });
        }
      }

      if (!_allModels.length) {
        $matrixBody.innerHTML = '<tr><td colspan="6" class="table-empty">No models available</td></tr>';
        return;
      }

      // Group by provider for section headers
      let html = '';
      let lastProvider = '';

      for (const m of _allModels) {
        const key = `${m.provider}/${m.id}`;

        if (m.provider !== lastProvider) {
          lastProvider = m.provider;
          const label = m.provider === 'ollama-local' ? 'Ollama (Laptop)'
            : m.provider === 'ollama' ? 'Ollama (Office 4090)'
            : m.provider === 'openai' ? 'OpenAI'
            : m.provider === 'gemini' ? 'Google Gemini'
            : m.provider === 'deepseek' ? 'DeepSeek'
            : m.provider;
          html += `<tr class="matrix-provider-row"><td colspan="6">${label}</td></tr>`;
        }

        html += `<tr data-model-key="${key}">`;
        html += `<td>${m.id}</td>`;

        for (const app of APPS) {
          // Determine checked state
          const appOverride = overrides[key]?.[app.id];
          let checked;
          if (appOverride !== undefined) {
            checked = appOverride;
          } else {
            checked = !globalHidden.has(key);
          }
          html += `<td><input type="checkbox" data-app="${app.id}" ${checked ? 'checked' : ''}></td>`;
        }

        html += '</tr>';
      }

      $matrixBody.innerHTML = html;
    } catch (err) {
      $matrixBody.innerHTML = `<tr><td colspan="6" class="table-empty">Error: ${err.message}</td></tr>`;
    }
  }

  async function saveAvailability() {
    try {
      // Read the matrix state
      const globalHidden = [];
      const appOverrides = {};

      const rows = $matrixBody.querySelectorAll('tr[data-model-key]');
      for (const row of rows) {
        const key = row.dataset.modelKey;
        const checks = row.querySelectorAll('input[type="checkbox"]');
        const states = {};
        let allChecked = true;
        let allUnchecked = true;

        checks.forEach(cb => {
          const appId = cb.dataset.app;
          states[appId] = cb.checked;
          if (cb.checked) allUnchecked = false;
          else allChecked = false;
        });

        if (allUnchecked) {
          // Hidden from all apps — add to global_hidden
          globalHidden.push(key);
        } else if (!allChecked) {
          // Mixed — store per-app overrides
          // We store as: global_hidden=false (visible by default), override specific apps to false
          // OR we could store: if most are checked, mark the unchecked ones as overrides
          const overrideObj = {};
          for (const app of APPS) {
            if (!states[app.id]) {
              overrideObj[app.id] = false;
            }
          }
          if (Object.keys(overrideObj).length) {
            appOverrides[key] = overrideObj;
          }
        }
        // If allChecked, no entry needed (default = visible)
      }

      await API.saveRegistry({ global_hidden: globalHidden, app_overrides: appOverrides });

      $btnSave.textContent = 'Saved!';
      $btnSave.style.background = 'var(--success)';
      setTimeout(() => {
        $btnSave.textContent = 'Save Changes';
        $btnSave.style.background = '';
      }, 2000);
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  }

  // ===================== Sub-tab Navigation =====================

  function initSubtabs() {
    const subtabs = document.querySelectorAll('.settings-subtab');
    const panels = document.querySelectorAll('.settings-panel');

    subtabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.subtab;
        subtabs.forEach(t => t.classList.remove('active'));
        panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('settings-' + target).classList.add('active');

        // Lazy-load panels on first visit
        if (target === 'availability' && !_registry) {
          loadAvailabilityMatrix();
        }
      });
    });
  }

  // ===================== Init =====================

  function init() {
    initSubtabs();

    // Ollama pull
    $btnPull.addEventListener('click', pullModel);
    $pullInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pullModel();
    });

    // API discovery
    $btnDiscover.addEventListener('click', () => discoverModels(true));

    // Availability save
    $btnSave.addEventListener('click', saveAvailability);

    // Initial data loads
    loadAvailabilityMatrix();
    refreshGpuStatus();
    refreshModelList();
    refreshComfyuiModels();

    // Auto-load API models (cached, not forced)
    discoverModels(false);

    // Auto-refresh GPU status every 15s
    setInterval(refreshGpuStatus, 15000);
  }

  return { init, refreshModelList, refreshGpuStatus };
})();
