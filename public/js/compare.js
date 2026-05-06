/**
 * compare.js — Compare mode: send the same prompt to 2+ models, view results with tab switching
 */
const Compare = (() => {
  // DOM refs
  const $overlay = document.getElementById('compare-overlay');
  const $btnOpen = document.getElementById('btn-compare-mode');
  const $btnClose = document.getElementById('btn-compare-close');
  const $modelList = document.getElementById('compare-model-list');
  const $sysPrompt = document.getElementById('compare-system-prompt');
  const $temperature = document.getElementById('compare-temperature');
  const $tempValue = document.getElementById('compare-temp-value');
  const $prompt = document.getElementById('compare-prompt');
  const $btnCompare = document.getElementById('btn-compare');
  const $btnStop = document.getElementById('btn-compare-stop');
  const $tabs = document.getElementById('compare-tabs');
  const $output = document.getElementById('compare-output');

  let abortControllers = [];
  let results = {};  // keyed by "provider/model"
  let activeTab = null;

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    try { return marked.parse(text); } catch { return text; }
  }

  // --- Populate model checkboxes from providers cache ---
  function populateModels() {
    const providers = window.getProvidersCache();
    if (!providers) {
      $modelList.textContent = 'No providers loaded yet.';
      return;
    }

    $modelList.innerHTML = '';
    for (const prov of providers) {
      if (!prov.models.length) continue;
      const groupEl = document.createElement('div');
      groupEl.className = 'compare-provider-group';

      const header = document.createElement('div');
      header.className = 'compare-provider-name';
      header.textContent = prov.name;
      groupEl.appendChild(header);

      for (const m of prov.models) {
        const label = document.createElement('label');
        label.className = 'compare-model-option';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = prov.id + '/' + m.id;
        cb.dataset.name = m.name;
        if (prov.status === 'no_key') cb.disabled = true;
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + m.name + (m.size ? ` (${m.size})` : '')));
        groupEl.appendChild(label);
      }
      $modelList.appendChild(groupEl);
    }
  }

  function getSelectedModels() {
    return Array.from($modelList.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => ({
        value: cb.value,
        name: cb.dataset.name,
        provider: cb.value.split('/')[0],
        model: cb.value.split('/').slice(1).join('/'),
      }));
  }

  // --- Tabs & output rendering ---
  function renderTabs() {
    $tabs.innerHTML = '';
    const keys = Object.keys(results);
    for (const key of keys) {
      const tab = document.createElement('button');
      const r = results[key];
      tab.className = 'compare-tab' + (key === activeTab ? ' active' : '');
      const icon = r.status === 'streaming' ? '<span class="compare-tab-dot streaming"></span>'
                 : r.status === 'done' ? '<span class="compare-tab-dot done"></span>'
                 : r.status === 'error' ? '<span class="compare-tab-dot error"></span>'
                 : '';
      tab.innerHTML = icon + r.name;
      tab.addEventListener('click', () => {
        activeTab = key;
        renderTabs();
        renderOutput();
      });
      $tabs.appendChild(tab);
    }
  }

  function renderOutput() {
    if (!activeTab || !results[activeTab]) {
      $output.innerHTML = '<div class="gallery-empty">Select 2+ models, write a prompt, and click Compare.</div>';
      return;
    }

    const r = results[activeTab];
    let html = '<div class="compare-result-content">';

    if (r.content) {
      html += '<div class="message-content">' + renderMarkdown(r.content) + '</div>';
    }

    if (r.status === 'streaming' && !r.content) {
      html += '<div class="thinking-dots"><span></span><span></span><span></span></div>';
    }

    if (r.meta && r.status === 'done') {
      const parts = [];
      if (r.meta.tokens_eval) {
        const tps = r.meta.eval_duration_ms
          ? Math.round(r.meta.tokens_eval / (r.meta.eval_duration_ms / 1000))
          : (r.meta.duration_ms ? Math.round(r.meta.tokens_eval / (r.meta.duration_ms / 1000)) : '');
        parts.push(`${r.meta.tokens_eval} tokens${tps ? ` (${tps} tok/s)` : ''}`);
      }
      if (r.meta.duration_ms) parts.push(`${(r.meta.duration_ms / 1000).toFixed(1)}s`);
      if (parts.length) html += `<div class="message-meta">${parts.join(' | ')}</div>`;
    }

    if (r.status === 'error') {
      html += `<div class="message-meta" style="color: var(--danger)">Error: ${r.error || 'Unknown error'}</div>`;
    }

    html += '</div>';
    $output.innerHTML = html;

    // Add copy buttons to code blocks
    $output.querySelectorAll('pre').forEach(pre => {
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(pre.textContent);
        btn.textContent = 'Copied!';
        setTimeout(() => btn.textContent = 'Copy', 1500);
      });
      pre.style.position = 'relative';
      pre.appendChild(btn);
    });
  }

  // --- Run comparison ---
  async function runComparison() {
    const selected = getSelectedModels();
    if (selected.length < 2) return alert('Select at least 2 models to compare.');
    const prompt = $prompt.value.trim();
    if (!prompt) return alert('Enter a prompt.');

    // Reset state
    results = {};
    abortControllers = [];
    const systemPrompt = $sysPrompt.value.trim();
    const temperature = parseFloat($temperature.value);

    for (const s of selected) {
      results[s.value] = { name: s.name, content: '', meta: null, status: 'streaming', error: null };
    }
    activeTab = selected[0].value;
    renderTabs();
    renderOutput();

    $btnCompare.classList.add('hidden');
    $btnStop.classList.remove('hidden');

    // Launch all requests in parallel
    const promises = selected.map(s => {
      const ac = new AbortController();
      abortControllers.push(ac);

      const messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      messages.push({ role: 'user', content: prompt });

      let lastRender = 0;
      return API.chat(
        s.provider,
        s.model,
        messages,
        { temperature },
        ac.signal,
        (accumulated) => {
          results[s.value].content = accumulated;
          const now = Date.now();
          if (now - lastRender > 80) {
            lastRender = now;
            renderTabs();
            if (activeTab === s.value) renderOutput();
          }
        }
      ).then(result => {
        results[s.value].content = result.content;
        results[s.value].meta = result;
        results[s.value].status = 'done';
        renderTabs();
        if (activeTab === s.value) renderOutput();
      }).catch(err => {
        results[s.value].status = 'error';
        results[s.value].error = err.name === 'AbortError' ? 'Stopped' : err.message;
        renderTabs();
        if (activeTab === s.value) renderOutput();
      });
    });

    await Promise.allSettled(promises);
    $btnCompare.classList.remove('hidden');
    $btnStop.classList.add('hidden');
  }

  function stopAll() {
    abortControllers.forEach(ac => ac.abort());
  }

  function open() {
    populateModels();
    $overlay.classList.remove('hidden');
  }

  function close() {
    stopAll();
    $overlay.classList.add('hidden');
  }

  function init() {
    $btnOpen.addEventListener('click', open);
    $btnClose.addEventListener('click', close);
    $btnCompare.addEventListener('click', runComparison);
    $btnStop.addEventListener('click', stopAll);

    $temperature.addEventListener('input', () => {
      $tempValue.textContent = parseFloat($temperature.value).toFixed(1);
    });

    // Ctrl+Enter to run comparison from prompt textarea
    $prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        runComparison();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$overlay.classList.contains('hidden')) {
        close();
      }
    });
  }

  return { init };
})();
