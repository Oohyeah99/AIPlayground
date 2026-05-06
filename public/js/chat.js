/**
 * chat.js — Chat tab: conversations, streaming LLM chat, markdown rendering, file attachments
 */
const Chat = (() => {
  let conversations = [];
  let activeConvId = null;
  let abortController = null;
  let isGenerating = false;
  let pendingAttachments = []; // [{ name, mime, data (base64), previewUrl }]

  // DOM refs
  const $convList = document.getElementById('conv-list');
  const $messages = document.getElementById('messages');
  const $welcome = document.getElementById('welcome-message');
  const $input = document.getElementById('chat-input');
  const $btnSend = document.getElementById('btn-send');
  const $btnStop = document.getElementById('btn-stop');
  const $btnAttach = document.getElementById('btn-attach');
  const $fileInput = document.getElementById('file-input');
  const $attachPreview = document.getElementById('attachment-preview');
  const $modelSelect = document.getElementById('chat-model-select');
  const $sysPromptEditor = document.getElementById('system-prompt-editor');
  const $sysPromptInput = document.getElementById('system-prompt-input');
  const $settingsPanel = document.getElementById('chat-settings-panel');
  const $temperature = document.getElementById('chat-temperature');
  const $tempValue = document.getElementById('chat-temp-value');
  const $thinkToggle = document.getElementById('chat-think');
  const $jsonToggle = document.getElementById('chat-json');

  // Markdown config
  function initMarked() {
    if (typeof marked === 'undefined') return;
    marked.setOptions({
      gfm: true,
      breaks: true,
      highlight: (code, lang) => {
        if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return typeof hljs !== 'undefined' ? hljs.highlightAuto(code).value : code;
      },
    });
  }

  function renderMarkdown(text) {
    if (typeof marked === 'undefined') return escapeHtml(text);
    try { return marked.parse(text); } catch { return escapeHtml(text); }
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // --- File attachments ---
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // result is "data:mime;base64,XXXX" — extract just the base64 part
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFiles(files) {
    for (const file of files) {
      if (file.size > 20 * 1024 * 1024) {
        alert(`File "${file.name}" is too large (max 20MB).`);
        continue;
      }
      const data = await readFileAsBase64(file);
      const att = { name: file.name, mime: file.type, data };
      if (file.type.startsWith('image/')) {
        att.previewUrl = URL.createObjectURL(file);
      }
      pendingAttachments.push(att);
    }
    renderAttachmentPreview();
  }

  function removeAttachment(index) {
    const att = pendingAttachments[index];
    if (att.previewUrl) URL.revokeObjectURL(att.previewUrl);
    pendingAttachments.splice(index, 1);
    renderAttachmentPreview();
  }

  function clearAttachments() {
    pendingAttachments.forEach(a => { if (a.previewUrl) URL.revokeObjectURL(a.previewUrl); });
    pendingAttachments = [];
    renderAttachmentPreview();
  }

  function renderAttachmentPreview() {
    if (pendingAttachments.length === 0) {
      $attachPreview.classList.add('hidden');
      $attachPreview.innerHTML = '';
      return;
    }

    $attachPreview.classList.remove('hidden');
    $attachPreview.innerHTML = '';

    pendingAttachments.forEach((att, i) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';

      if (att.previewUrl) {
        chip.innerHTML = `
          <img src="${att.previewUrl}" class="attachment-thumb" alt="${escapeHtml(att.name)}">
          <span class="attachment-name">${escapeHtml(att.name)}</span>
          <button class="attachment-remove" data-idx="${i}">&times;</button>
        `;
      } else {
        const icon = att.mime === 'application/pdf' ? 'PDF'
          : att.mime.includes('word') ? 'DOC'
          : 'TXT';
        chip.innerHTML = `
          <span class="attachment-icon">${icon}</span>
          <span class="attachment-name">${escapeHtml(att.name)}</span>
          <button class="attachment-remove" data-idx="${i}">&times;</button>
        `;
      }

      chip.querySelector('.attachment-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        removeAttachment(parseInt(e.target.dataset.idx));
      });
      $attachPreview.appendChild(chip);
    });
  }

  // --- Conversation list ---
  function renderConvList() {
    $convList.innerHTML = '';
    for (const conv of conversations) {
      const el = document.createElement('div');
      el.className = 'conv-item' + (conv.id === activeConvId ? ' active' : '');
      el.innerHTML = `
        <span class="conv-item-title">${escapeHtml(conv.title)}</span>
        <span class="conv-item-model">${escapeHtml(conv.model || '')}</span>
        <button class="conv-item-delete" data-id="${conv.id}" title="Delete">&times;</button>
      `;
      el.addEventListener('click', (e) => {
        if (e.target.closest('.conv-item-delete')) return;
        loadConversation(conv.id);
      });
      el.querySelector('.conv-item-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await API.deleteConversation(conv.id);
        conversations = conversations.filter(c => c.id !== conv.id);
        if (activeConvId === conv.id) {
          activeConvId = null;
          $messages.innerHTML = '';
          $welcome.classList.remove('hidden');
        }
        renderConvList();
      });
      $convList.appendChild(el);
    }
  }

  async function loadConversations() {
    conversations = await API.getConversations();
    renderConvList();
  }

  async function loadConversation(id) {
    activeConvId = id;
    const conv = conversations.find(c => c.id === id);
    if (conv?.model) $modelSelect.value = conv.model;
    if (conv?.system_prompt) $sysPromptInput.value = conv.system_prompt;
    else $sysPromptInput.value = '';

    renderConvList();
    $welcome.classList.add('hidden');
    $messages.innerHTML = '';

    const messages = await API.getMessages(id);
    for (const msg of messages) {
      appendMessage(msg.role, msg.content, msg);
    }
    scrollToBottom();
  }

  async function newConversation() {
    const model = $modelSelect.value;
    const conv = await API.createConversation({
      title: 'New Chat',
      model,
      system_prompt: $sysPromptInput.value || '',
    });
    conversations.unshift(conv);
    await loadConversation(conv.id);
  }

  // --- Message rendering ---
  function appendMessage(role, content, meta) {
    $welcome.classList.add('hidden');
    const el = document.createElement('div');
    el.className = `message ${role}`;

    const avatar = role === 'user' ? 'U' : 'AI';
    const renderedContent = role === 'assistant' ? renderMarkdown(content) : escapeHtml(content).replace(/\n/g, '<br>');

    // Build attachment thumbnails for user messages
    let attachHtml = '';
    if (meta?.attachments && meta.attachments.length > 0) {
      attachHtml = '<div class="message-attachments">';
      for (const att of meta.attachments) {
        if (att.mime && att.mime.startsWith('image/') && att.data) {
          attachHtml += `<img src="data:${att.mime};base64,${att.data}" class="message-image" alt="${escapeHtml(att.name)}">`;
        } else {
          const icon = att.mime === 'application/pdf' ? 'PDF' : att.mime?.includes('word') ? 'DOC' : 'TXT';
          attachHtml += `<span class="message-file-badge">${icon}: ${escapeHtml(att.name)}</span>`;
        }
      }
      attachHtml += '</div>';
    }

    let metaHtml = '';
    if (meta?.tokens_eval || meta?.model) {
      const parts = [];
      const provLabel = meta.provider && meta.provider !== 'ollama' ? meta.provider.charAt(0).toUpperCase() + meta.provider.slice(1) + ' | ' : '';
      if (meta.model) parts.push(`<strong>${provLabel}${escapeHtml(meta.model)}</strong>`);
      if (meta.tokens_eval) {
        const tps = meta.eval_duration_ms ? Math.round(meta.tokens_eval / (meta.eval_duration_ms / 1000)) : (meta.duration_ms ? Math.round(meta.tokens_eval / (meta.duration_ms / 1000)) : '');
        parts.push(`${meta.tokens_eval} tokens${tps ? ` (${tps} tok/s)` : ''}`);
      }
      if (meta.duration_ms) parts.push(`${(meta.duration_ms / 1000).toFixed(1)}s`);
      metaHtml = `<div class="message-meta">${parts.join(' | ')}</div>`;
    }

    el.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div>
        ${attachHtml}
        <div class="message-content">${renderedContent}</div>
        ${metaHtml}
      </div>
    `;

    // Add copy buttons to code blocks
    el.querySelectorAll('pre').forEach(pre => {
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

    $messages.appendChild(el);
    return el;
  }

  function appendThinking() {
    const el = document.createElement('div');
    el.className = 'message assistant';
    el.id = 'thinking-message';
    el.innerHTML = `
      <div class="message-avatar">AI</div>
      <div>
        <div class="message-content">
          <div class="thinking-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    `;
    $messages.appendChild(el);
    scrollToBottom();
    return el;
  }

  function updateStreamingMessage(el, content) {
    const contentEl = el.querySelector('.message-content');
    contentEl.innerHTML = renderMarkdown(content);
  }

  function finalizeStreamingMessage(el, content, meta) {
    const contentEl = el.querySelector('.message-content');
    contentEl.innerHTML = renderMarkdown(content);

    // Add copy buttons
    el.querySelectorAll('pre').forEach(pre => {
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

    // Add meta
    if (meta?.tokens_eval || meta?.model) {
      const parts = [];
      if (meta.model) parts.push(meta.model);
      if (meta.tokens_eval) {
        const tps = meta.eval_duration_ms ? Math.round(meta.tokens_eval / (meta.eval_duration_ms / 1000)) : '';
        parts.push(`${meta.tokens_eval} tokens${tps ? ` (${tps} tok/s)` : ''}`);
      }
      if (meta.duration_ms) parts.push(`${(meta.duration_ms / 1000).toFixed(1)}s`);
      const metaEl = document.createElement('div');
      metaEl.className = 'message-meta';
      metaEl.innerHTML = parts.length ? `<strong>${parts[0]}</strong>${parts.length > 1 ? ' | ' + parts.slice(1).join(' | ') : ''}` : '';
      el.querySelector('.message-content').parentElement.appendChild(metaEl);
    }
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      $messages.scrollTop = $messages.scrollHeight;
    });
  }

  // --- Send message ---
  async function sendMessage() {
    const text = $input.value.trim();
    if ((!text && pendingAttachments.length === 0) || isGenerating) return;

    const selectValue = $modelSelect.value;
    if (!selectValue) return alert('Select a model first');

    // Parse "provider/model" format
    const slashIdx = selectValue.indexOf('/');
    const provider = slashIdx > 0 ? selectValue.slice(0, slashIdx) : 'ollama';
    const model = slashIdx > 0 ? selectValue.slice(slashIdx + 1) : selectValue;

    // Create conversation if needed
    if (!activeConvId) {
      await newConversation();
    }

    // Update conversation model if changed
    const conv = conversations.find(c => c.id === activeConvId);
    if (conv && conv.model !== selectValue) {
      conv.model = selectValue;
      await API.updateConversation(activeConvId, { model: selectValue });
    }

    // Capture attachments before clearing
    const attachments = pendingAttachments.map(a => ({ name: a.name, mime: a.mime, data: a.data }));
    const displayAttachments = pendingAttachments.map(a => ({ name: a.name, mime: a.mime, data: a.data }));

    // Save & display user message (with attachment previews)
    const displayText = text || (attachments.length ? `[${attachments.length} file(s) attached]` : '');
    appendMessage('user', displayText, { attachments: displayAttachments });
    await API.saveMessage(activeConvId, { role: 'user', content: displayText });
    $input.value = '';
    $input.style.height = 'auto';
    clearAttachments();
    scrollToBottom();

    // Auto-title from first message
    if (conv && conv.title === 'New Chat') {
      const titleText = text || attachments.map(a => a.name).join(', ');
      const title = titleText.slice(0, 60) + (titleText.length > 60 ? '...' : '');
      conv.title = title;
      API.updateConversation(activeConvId, { title });
      renderConvList();
    }

    // Build messages array
    const allMsgs = await API.getMessages(activeConvId);
    const chatMessages = [];
    const sysPrompt = $sysPromptInput.value.trim();
    if (sysPrompt) chatMessages.push({ role: 'system', content: sysPrompt });
    for (const m of allMsgs) {
      if (m.role !== 'system') chatMessages.push({ role: m.role, content: m.content });
    }

    // Attach files to the last user message
    if (attachments.length > 0) {
      const lastMsg = chatMessages[chatMessages.length - 1];
      if (lastMsg && lastMsg.role === 'user') {
        lastMsg.attachments = attachments;
      }
    }

    // Start streaming
    isGenerating = true;
    $btnSend.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    abortController = new AbortController();

    const thinkingEl = appendThinking();
    let streamEl = null;
    let lastRender = 0;

    try {
      const result = await API.chat(
        provider,
        model,
        chatMessages,
        {
          temperature: parseFloat($temperature.value),
          think: $thinkToggle.checked,
        },
        abortController.signal,
        (accumulated) => {
          if (!streamEl) {
            thinkingEl.remove();
            streamEl = appendMessage('assistant', '');
          }
          const now = Date.now();
          if (now - lastRender > 50) {
            lastRender = now;
            updateStreamingMessage(streamEl, accumulated);
            scrollToBottom();
          }
        }
      );

      // Final render
      if (!streamEl) {
        thinkingEl.remove();
        streamEl = appendMessage('assistant', '');
      }
      finalizeStreamingMessage(streamEl, result.content, { ...result, model, provider });
      scrollToBottom();

      // Save assistant message
      await API.saveMessage(activeConvId, {
        role: 'assistant',
        content: result.content,
        model,
        provider,
        tokens_eval: result.tokens_eval,
        tokens_prompt: result.tokens_prompt,
        duration_ms: result.duration_ms,
      });
    } catch (err) {
      thinkingEl.remove();
      if (streamEl) streamEl.remove();
      if (err.name !== 'AbortError') {
        appendMessage('assistant', `Error: ${err.message}`);
      }
    } finally {
      isGenerating = false;
      abortController = null;
      $btnSend.classList.remove('hidden');
      $btnStop.classList.add('hidden');
    }
  }

  function stopGeneration() {
    if (abortController) abortController.abort();
  }

  // --- Init ---
  function init() {
    initMarked();

    // Event listeners
    document.getElementById('btn-new-chat').addEventListener('click', async () => {
      activeConvId = null;
      $messages.innerHTML = '';
      $welcome.classList.remove('hidden');
      $sysPromptInput.value = '';
      clearAttachments();
      renderConvList();
    });

    $btnSend.addEventListener('click', sendMessage);
    $btnStop.addEventListener('click', stopGeneration);

    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-grow textarea
    $input.addEventListener('input', () => {
      $input.style.height = 'auto';
      $input.style.height = Math.min($input.scrollHeight, 200) + 'px';
    });

    // File attachment
    $btnAttach.addEventListener('click', () => $fileInput.click());
    $fileInput.addEventListener('change', () => {
      if ($fileInput.files.length) {
        handleFiles($fileInput.files);
        $fileInput.value = ''; // reset so same file can be re-selected
      }
    });

    // Drag and drop on chat input area
    const $inputArea = $input.closest('.chat-input-area');
    $inputArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      $inputArea.classList.add('drag-over');
    });
    $inputArea.addEventListener('dragleave', () => {
      $inputArea.classList.remove('drag-over');
    });
    $inputArea.addEventListener('drop', (e) => {
      e.preventDefault();
      $inputArea.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });

    // Paste image from clipboard
    $input.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          files.push(item.getAsFile());
        }
      }
      if (files.length) {
        e.preventDefault();
        handleFiles(files);
      }
    });

    // System prompt toggle
    document.getElementById('btn-system-prompt').addEventListener('click', () => {
      $sysPromptEditor.classList.toggle('hidden');
    });

    // Save system prompt on change
    $sysPromptInput.addEventListener('change', () => {
      if (activeConvId) {
        API.updateConversation(activeConvId, { system_prompt: $sysPromptInput.value });
      }
    });

    // Settings toggle
    document.getElementById('btn-chat-settings').addEventListener('click', () => {
      $settingsPanel.classList.toggle('hidden');
    });

    // Temperature display
    $temperature.addEventListener('input', () => {
      $tempValue.textContent = parseFloat($temperature.value).toFixed(1);
    });

    // Load conversations
    loadConversations();
  }

  return { init, loadModels: loadConversations };
})();
