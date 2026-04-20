/**
 * models.js — Models tab: GPU status, model list, pull/delete
 */
const Models = (() => {
  const $gpuName = document.getElementById('gpu-name');
  const $gpuVramFill = document.getElementById('gpu-vram-fill');
  const $gpuVramText = document.getElementById('gpu-vram-text');
  const $gpuComfyui = document.getElementById('gpu-comfyui-version');
  const $gpuLoaded = document.getElementById('gpu-loaded-models');
  const $modelsBody = document.getElementById('models-table-body');
  const $comfyuiModels = document.getElementById('comfyui-models-list');
  const $pullInput = document.getElementById('pull-model-name');
  const $btnPull = document.getElementById('btn-pull-model');
  const $pullProgress = document.getElementById('pull-progress');
  const $pullFill = document.getElementById('pull-progress-fill');
  const $pullText = document.getElementById('pull-progress-text');

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

    // Loaded models from Ollama
    try {
      const ps = await API.ollamaPs();
      const loaded = (ps.models || []).map(m => m.name).join(', ');
      $gpuLoaded.textContent = loaded || 'None';
    } catch {
      $gpuLoaded.textContent = 'Unknown';
    }
  }

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

      // Delete buttons
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

  function init() {
    $btnPull.addEventListener('click', pullModel);
    $pullInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') pullModel();
    });

    refreshGpuStatus();
    refreshModelList();
    refreshComfyuiModels();

    // Auto-refresh GPU status every 15s
    setInterval(refreshGpuStatus, 15000);
  }

  return { init, refreshModelList, refreshGpuStatus };
})();
