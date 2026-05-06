/**
 * tts.js — Text-to-Speech tab: Gemini + OpenAI TTS with provider switching
 * Audio files are persisted to disk and DB, surviving page refreshes.
 */
const TTS = (() => {
  const $provider = document.getElementById('tts-provider');
  const $text = document.getElementById('tts-text');
  const $voice = document.getElementById('tts-voice');
  const $language = document.getElementById('tts-language');
  const $prompt = document.getElementById('tts-prompt');
  const $speed = document.getElementById('tts-speed');
  const $speedValue = document.getElementById('tts-speed-value');
  const $btnGenerate = document.getElementById('btn-gen-tts');
  const $progress = document.getElementById('tts-progress');
  const $gallery = document.getElementById('tts-gallery');

  // Provider-specific voice lists
  const GEMINI_VOICES = [
    'Kore', 'Aoede', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Puck', 'Zephyr',
    'Altair', 'Aurora', 'Basalt', 'Cove', 'Ember', 'Haven', 'Iris', 'Juniper',
    'Maple', 'Nova', 'Orbit', 'Pine', 'Reef', 'Sage', 'Solstice', 'Terrain', 'Vale', 'Wren',
  ];
  const OPENAI_VOICES = [
    { id: 'alloy', name: 'Alloy (Neutral)' },
    { id: 'ash', name: 'Ash (Confident)' },
    { id: 'ballad', name: 'Ballad (Warm)' },
    { id: 'coral', name: 'Coral (Clear)' },
    { id: 'echo', name: 'Echo (Smooth)' },
    { id: 'fable', name: 'Fable (Expressive)' },
    { id: 'onyx', name: 'Onyx (Deep)' },
    { id: 'nova', name: 'Nova (Friendly)' },
    { id: 'sage', name: 'Sage (Authoritative)' },
    { id: 'shimmer', name: 'Shimmer (Bright)' },
  ];

  let history = [];

  function updateVoiceList() {
    const isOpenAI = $provider.value === 'openai';
    $voice.innerHTML = '';

    if (isOpenAI) {
      for (const v of OPENAI_VOICES) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.name;
        $voice.appendChild(opt);
      }
    } else {
      for (const v of GEMINI_VOICES) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v + (v === 'Kore' ? ' (Default)' : '');
        $voice.appendChild(opt);
      }
    }

    // Show/hide provider-specific controls
    document.getElementById('tts-language-group').classList.toggle('hidden', isOpenAI);
    document.getElementById('tts-prompt-group').classList.toggle('hidden', isOpenAI);
    document.getElementById('tts-speed-group').classList.toggle('hidden', !isOpenAI);
    document.querySelector('.tts-tags-ref').classList.toggle('hidden', isOpenAI);
  }

  async function generate() {
    const text = $text.value.trim();
    if (!text) return alert('Enter text to generate speech.');

    $btnGenerate.disabled = true;
    $progress.classList.remove('hidden');
    const isOpenAI = $provider.value === 'openai';
    $progress.querySelector('.progress-text').textContent = isOpenAI
      ? 'Generating audio...'
      : 'Generating audio (may retry on rate limit)...';

    try {
      const body = {
        text,
        voice: $voice.value,
        provider: $provider.value,
      };

      if (!isOpenAI) {
        body.language_code = $language.value;
        const promptVal = $prompt.value.trim();
        if (promptVal) body.prompt = promptVal;
      } else {
        body.speed = parseFloat($speed.value) || 1.0;
      }

      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `TTS failed: ${res.status}`);
      }

      const data = await res.json();
      const entry = {
        text: data.text,
        voice: data.voice,
        audioSrc: `/outputs/${data.filename}`,
        mimeType: data.mimeType,
        provider: data.provider || $provider.value,
        filename: data.filename,
        timestamp: new Date().toLocaleTimeString(),
      };
      history.unshift(entry);
      renderGallery();
    } catch (err) {
      alert(`TTS Error: ${err.message}`);
    } finally {
      $btnGenerate.disabled = false;
      $progress.classList.add('hidden');
    }
  }

  function addCard(entry) {
    const card = document.createElement('div');
    card.className = 'tts-card';

    const providerLabel = entry.provider === 'openai' ? 'OpenAI' : 'Gemini';

    card.innerHTML = `
      <div class="tts-card-header">
        <span class="tts-card-voice">${escapeHtml(entry.voice)} <span style="font-size:10px;color:var(--text-muted);font-weight:400">${providerLabel}</span></span>
        <span class="tts-card-time">${entry.timestamp}</span>
      </div>
      <audio controls class="tts-audio">
        <source src="${entry.audioSrc}" type="${entry.mimeType}">
      </audio>
      <div class="tts-card-text">${escapeHtml(entry.text)}</div>
      <div class="tts-card-actions">
        <button class="btn btn-ghost btn-sm tts-copy" title="Copy text">Copy Text</button>
        <button class="btn btn-accent btn-sm tts-use" title="Use this text">Use Text</button>
        <button class="btn btn-ghost btn-sm tts-download" title="Download">Download</button>
      </div>
    `;

    // Download handler
    card.querySelector('.tts-download').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = entry.audioSrc;
      const ext = entry.mimeType.includes('mp3') ? 'mp3' : entry.mimeType.includes('ogg') ? 'ogg' : 'wav';
      a.download = entry.filename || `tts-${entry.voice}-${Date.now()}.${ext}`;
      a.click();
    });

    // Copy text handler
    card.querySelector('.tts-copy').addEventListener('click', () => {
      navigator.clipboard.writeText(entry.text).then(() => {
        const btn = card.querySelector('.tts-copy');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy Text'; }, 1500);
      });
    });

    // Use text handler
    card.querySelector('.tts-use').addEventListener('click', () => {
      $text.value = entry.text;
      $text.focus();
      $text.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    $gallery.appendChild(card);
  }

  function renderGallery() {
    if (history.length === 0) {
      $gallery.innerHTML = '<div class="gallery-empty">No audio generated yet. Write text and click Generate Speech.</div>';
      return;
    }

    $gallery.innerHTML = '';
    for (const entry of history) {
      addCard(entry);
    }
  }

  async function loadHistory() {
    try {
      const res = await fetch('/api/tts/history?limit=50');
      if (!res.ok) return;
      const items = await res.json();
      if (!items.length) return;

      // Convert DB rows to history entries (newest first, already sorted by server)
      for (const item of items) {
        history.push({
          text: item.text,
          voice: item.voice,
          audioSrc: `/outputs/${item.filename}`,
          mimeType: item.mime_type,
          provider: item.provider,
          filename: item.filename,
          timestamp: new Date(item.created_at + 'Z').toLocaleTimeString(),
        });
      }
      renderGallery();
    } catch {}
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Insert tag into textarea at cursor position
  function insertTag(tag) {
    const start = $text.selectionStart;
    const end = $text.selectionEnd;
    const value = $text.value;
    $text.value = value.slice(0, start) + tag + value.slice(end);
    $text.selectionStart = $text.selectionEnd = start + tag.length;
    $text.focus();
  }

  function init() {
    $btnGenerate.addEventListener('click', generate);

    // Provider switching
    $provider.addEventListener('change', updateVoiceList);

    // Speed slider display
    $speed.addEventListener('input', () => {
      $speedValue.textContent = parseFloat($speed.value).toFixed(2) + 'x';
    });

    // Ctrl+Enter shortcut
    $text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generate();
      }
    });

    // Make tags clickable to insert
    document.querySelectorAll('.tts-tag').forEach(tag => {
      tag.addEventListener('click', () => insertTag(tag.textContent));
      tag.style.cursor = 'pointer';
    });

    // Load persisted history
    loadHistory();
  }

  return { init };
})();
