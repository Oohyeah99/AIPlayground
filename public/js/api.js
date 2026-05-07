/**
 * api.js — Shared API client for Ollama, OpenAI, Gemini, and ComfyUI (via Express proxy)
 *
 * Cloud APIs (Imagen, OpenAI, Gemini, DeepSeek) are routed through Vercel
 * to bypass geographic restrictions (blocked in HK/China regions).
 * Requires browser proxy/VPN to reach Vercel from China.
 * Local APIs (Ollama, ComfyUI) go through the Azure VM proxy.
 */

// Vercel deployment URL — browser reaches this via proxy/VPN
const VERCEL_URL = 'https://ai-playground-test-xi.vercel.app';

function vercelUrl(path) {
  return `${VERCEL_URL}${path}`;
}

const API = {
  // --- Providers catalog ---
  async getProviders(app) {
    const url = app ? `/api/providers?app=${encodeURIComponent(app)}` : '/api/providers';
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Providers: ${res.status}`);
    return res.json();
  },

  // --- Unified streaming chat (all providers) ---
  /**
   * Streams chat from any provider. Calls onChunk(accumulatedText) for each token.
   * Returns { content, provider, model, tokens_eval, tokens_prompt, duration_ms }
   */
  async chat(provider, model, messages, options, signal, onChunk) {
    // Cloud providers (openai, gemini, deepseek) go through Vercel to bypass geographic restrictions.
    // Local providers (ollama, ollama-local) go through the Azure VM proxy.
    const cloudProviders = ['openai', 'gemini', 'deepseek'];
    const useVercel = cloudProviders.includes(provider);
    const baseUrl = useVercel ? vercelUrl('') : '';

    console.log('[API.chat] Calling /api/chat, provider=%s, model=%s, via=%s', provider, model, useVercel ? 'Vercel' : 'Azure VM');
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model, messages, options }),
      signal,
    });
    console.log('[API.chat] Response status: %d, contentType: %s', res.status, res.headers.get('content-type'));
    if (!res.ok) {
      const text = await res.text();
      console.error('[API.chat] Error response:', text);
      throw new Error(`Chat error ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let meta = {};
    let buf = '';
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log('[API.chat] Stream done, total chunks read: %d, accumulated length: %d', chunkCount, accumulated.length);
        break;
      }
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === 'chunk') {
            accumulated += data.content;
            chunkCount++;
            if (chunkCount <= 3) {
              console.log('[API.chat] Chunk %d: %s', chunkCount, data.content.slice(0, 50));
            }
            if (onChunk) onChunk(accumulated);
          } else if (data.type === 'done') {
            console.log('[API.chat] Done event, meta: %s', JSON.stringify(data.meta));
            meta = data.meta || {};
            accumulated = data.content || accumulated;
          } else if (data.type === 'error') {
            console.error('[API.chat] Error event:', data.message);
            throw new Error(data.message);
          }
        } catch (e) {
          if (e.message && !e.message.startsWith('Unexpected')) {
            console.error('[API.chat] Parse error:', e.message, 'line:', line.slice(0, 100));
            throw e;
          }
        }
      }
    }
    console.log('[API.chat] Returning, content length: %d', accumulated.length);
    return { content: accumulated, ...meta };
  },

  // --- Ollama direct (for model management) ---
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
    const text = await res.text();
    return text ? JSON.parse(text) : { status: 'ok' };
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
      keep_alive: '30m',
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

  async comfyuiFreeMemory() {
    const res = await fetch('/comfyui/free', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!res.ok) throw new Error(`ComfyUI free: ${res.status}`);
    return res.json();
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

  // --- Media Upload (persist Vercel base64 to Azure VM disk) ---
  async uploadMedia(filename, base64, mimeType) {
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, base64, mimeType }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Upload: ${res.status}`);
    }
    return res.json();
  },

  // --- Model Discovery & Registry ---
  async discoverModels(force = false) {
    const res = await fetch(`${vercelUrl('')}/api/models/discover${force ? '?force=true' : ''}`);
    if (!res.ok) throw new Error(`Discover: ${res.status}`);
    return res.json();
  },

  async getRegistry() {
    const res = await fetch('/api/models/registry');
    if (!res.ok) throw new Error(`Registry: ${res.status}`);
    return res.json();
  },

  async saveRegistry(data) {
    const res = await fetch('/api/models/registry', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Save registry: ${res.status}`);
    return res.json();
  },

  // --- Imagen (Google image generation) ---
  async imagen(prompt, model, aspectRatio, sampleCount) {
    const res = await fetch(`${vercelUrl('')}/api/imagen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, aspectRatio, sampleCount }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Imagen: ${res.status}`);
    }
    return res.json();
  },

  // --- DALL-E (OpenAI image generation) ---
  async dalle(prompt, model, aspectRatio) {
    const res = await fetch(`${vercelUrl('')}/api/dalle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, aspectRatio }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `DALL-E: ${res.status}`);
    }
    return res.json();
  },

  // --- Veo (Google video generation) ---
  async veoSubmit(prompt, model, aspectRatio, durationSeconds) {
    const res = await fetch(`${vercelUrl('')}/api/veo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, model, aspectRatio, durationSeconds }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Veo: ${res.status}`);
    }
    return res.json();
  },

  async veoPoll(operation) {
    const res = await fetch(`${vercelUrl('')}/api/veo/status?operation=${encodeURIComponent(operation)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Veo poll: ${res.status}`);
    }
    return res.json();
  },

  // --- Random Prompt Generator (DeepSeek) ---
  async randomPrompt(type) {
    const systemPrompts = {
      image: 'You are a creative prompt generator for AI image generation. Generate a single detailed, vivid image prompt. Include subject, setting, lighting, mood, and style details. Be creative and varied — pick random subjects from nature, architecture, food, portraits, sci-fi, fantasy, etc. Output ONLY the prompt text, nothing else. No quotes, no labels, no explanations.',
      video: 'You are a creative prompt generator for AI video generation. Generate a single detailed video clip prompt describing motion, scene, and visual dynamics. Include camera movement, subject action, and environment. Be creative and varied. Output ONLY the prompt text, nothing else. No quotes, no labels, no explanations.',
      audio: 'You are a creative text generator for AI text-to-speech. Generate a short, interesting passage of text (2-4 sentences) suitable for speech synthesis. Be creative — try quotes, stories, announcements, poems, or dramatic readings. You may include emotional tags like [whispering], [laughing], [sigh], [sarcasm]. Output ONLY the text to be spoken, nothing else. No quotes, no labels, no explanations.',
    };

    const systemPrompt = systemPrompts[type] || systemPrompts.image;
    const res = await fetch(`${vercelUrl('')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Generate a random prompt now.' },
        ],
        options: { temperature: 1.2 },
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Random prompt: ${res.status}`);
    }

    // DeepSeek chat returns NDJSON stream via Vercel
    const text = await res.text();
    const lines = text.trim().split('\n').filter(l => l.trim());
    let accumulated = '';
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'chunk') accumulated += parsed.content;
        if (parsed.type === 'done') accumulated = parsed.content || accumulated;
      } catch {}
    }
    return accumulated.trim();
  },
};
