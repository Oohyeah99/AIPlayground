/**
 * chat.js — Chat tab: conversations, streaming LLM chat, markdown rendering
 */
const Chat = (() => {
  let conversations = [];
  let activeConvId = null;
  let abortController = null;
  let isGenerating = false;

  // DOM refs
  const $convList = document.getElementById('conv-list');
  const $messages = document.getElementById('messages');
  const $welcome = document.getElementById('welcome-message');
  const $input = document.getElementById('chat-input');
  const $btnSend = document.getElementById('btn-send');
  const $btnStop = document.getElementById('btn-stop');
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

    let metaHtml = '';
    if (meta?.tokens_eval) {
      const tps = meta.eval_duration_ms ? Math.round(meta.tokens_eval / (meta.eval_duration_ms / 1000)) : '';
      metaHtml = `<div class="message-meta">${meta.tokens_eval} tokens${tps ? ` (${tps} tok/s)` : ''}${meta.duration_ms ? ` | ${(meta.duration_ms / 1000).toFixed(1)}s` : ''}</div>`;
    }

    el.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div>
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
    if (meta?.tokens_eval) {
      const tps = meta.eval_duration_ms ? Math.round(meta.tokens_eval / (meta.eval_duration_ms / 1000)) : '';
      const metaEl = document.createElement('div');
      metaEl.className = 'message-meta';
      metaEl.textContent = `${meta.tokens_eval} tokens${tps ? ` (${tps} tok/s)` : ''}${meta.duration_ms ? ` | ${(meta.duration_ms / 1000).toFixed(1)}s` : ''}`;
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
    if (!text || isGenerating) return;

    const model = $modelSelect.value;
    if (!model) return alert('Select a model first');

    // Create conversation if needed
    if (!activeConvId) {
      await newConversation();
    }

    // Update conversation model if changed
    const conv = conversations.find(c => c.id === activeConvId);
    if (conv && conv.model !== model) {
      conv.model = model;
      await API.updateConversation(activeConvId, { model });
    }

    // Save & display user message
    appendMessage('user', text);
    await API.saveMessage(activeConvId, { role: 'user', content: text });
    $input.value = '';
    $input.style.height = 'auto';
    scrollToBottom();

    // Auto-title from first message
    if (conv && conv.title === 'New Chat') {
      const title = text.slice(0, 60) + (text.length > 60 ? '...' : '');
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

    // Start streaming
    isGenerating = true;
    $btnSend.classList.add('hidden');
    $btnStop.classList.remove('hidden');
    abortController = new AbortController();

    const thinkingEl = appendThinking();
    let streamEl = null;
    let lastRender = 0;

    try {
      const result = await API.ollamaChat(
        model,
        chatMessages,
        {
          temperature: parseFloat($temperature.value),
          think: $thinkToggle.checked,
          json: $jsonToggle.checked,
        },
        abortController.signal,
        (accumulated) => {
          // Progressive rendering with RAF debounce
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
      finalizeStreamingMessage(streamEl, result.content, result);
      scrollToBottom();

      // Save assistant message
      await API.saveMessage(activeConvId, {
        role: 'assistant',
        content: result.content,
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
