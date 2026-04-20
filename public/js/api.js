/**
 * api.js — Shared API client for Ollama and ComfyUI (via Express proxy)
 */
const API = {
  // --- Ollama (proxied through /ollama/) ---
  async ollamaTags() {
    const res = await fetch('/ollama/api/tags');
    if (!res.ok) throw new Error(`Ollama tags: ${res.status}`);
    return res.json();
  },

  async ollamaPs() {
    const res = await fetch('/ollama/api/ps');
    if (!res.ok) throw new Error(`Ollama ps: ${res.status}`);
    return res.json();
  },

  async ollamaDelete(name) {
    const res = await fetch('/ollama/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
    return res.json();
  },

  async ollamaPull(name, onProgress) {
    const res = await fetch('/ollama/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });
    if (!res.ok) throw new Error(`Pull failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (onProgress) onProgress(data);
        } catch {}
      }
    }
  },

  /**
   * Streaming chat — calls onChunk(text) for each token,
   * returns the full accumulated response + metadata.
   */
  async ollamaChat(model, messages, opts, signal, onChunk) {
    const body = {
      model,
      messages,
      stream: true,
      think: opts.think || false,
      options: {},
    };
    if (opts.temperature !== undefined) body.options.temperature = opts.temperature;
    if (opts.num_predict) body.options.num_predict = opts.num_predict;
    if (opts.json) body.format = 'json';

    const res = await fetch('/ollama/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Chat error ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let meta = {};
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.message?.content) {
            accumulated += data.message.content;
            if (onChunk) onChunk(accumulated);
          }
          if (data.done) {
            meta = {
              tokens_eval: data.eval_count,
              tokens_prompt: data.prompt_eval_count,
              duration_ms: Math.round((data.total_duration || 0) / 1e6),
              eval_duration_ms: Math.round((data.eval_duration || 0) / 1e6),
            };
          }
        } catch {}
      }
    }
    return { content: accumulated, ...meta };
  },

  // --- ComfyUI (proxied through /comfyui/) ---
  async comfyuiStatus() {
    try {
      const res = await fetch('/comfyui/system_stats', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return { online: false };
      const data = await res.json();
      const device = (data.devices || [{}])[0];
      return {
        online: true,
        version: data.system?.comfyui_version,
        gpu: device.name,
        vram_free: device.vram_free,
        vram_total: device.vram_total,
      };
    } catch {
      return { online: false };
    }
  },

  async comfyuiModels() {
    const folders = ['diffusion_models', 'checkpoints', 'vae', 'text_encoders'];
    const result = {};
    for (const folder of folders) {
      try {
        const res = await fetch(`/comfyui/models/${folder}`, { signal: AbortSignal.timeout(5000) });
        result[folder] = res.ok ? await res.json() : [];
      } catch { result[folder] = []; }
    }
    return result;
  },

  async comfyuiSubmit(workflow) {
    const res = await fetch('/comfyui/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }),
    });
    if (!res.ok) throw new Error(`ComfyUI submit: ${res.status} ${await res.text()}`);
    const data = await res.json();
    if (data.error) throw new Error(`ComfyUI error: ${data.error}`);
    return data.prompt_id;
  },

  async comfyuiHistory(promptId) {
    const res = await fetch(`/comfyui/history/${promptId}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data[promptId] || null;
  },

  async comfyuiDownloadUrl(filename) {
    return `/comfyui/view?filename=${encodeURIComponent(filename)}&type=output`;
  },

  // --- Local backend (conversations, generations) ---
  async getConversations() {
    const res = await fetch('/api/conversations');
    return res.json();
  },

  async createConversation(data) {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },

  async updateConversation(id, data) {
    await fetch(`/api/conversations/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  async deleteConversation(id) {
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  },

  async getMessages(convId) {
    const res = await fetch(`/api/conversations/${convId}/messages`);
    return res.json();
  },

  async saveMessage(convId, msg) {
    const res = await fetch(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    return res.json();
  },

  async getGenerations(type, limit) {
    const res = await fetch(`/api/generations?type=${type}&limit=${limit || 50}`);
    return res.json();
  },

  async saveGeneration(data) {
    const res = await fetch('/api/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return res.json();
  },
};
