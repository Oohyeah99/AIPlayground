/**
 * Ollama streaming provider — translates Ollama NDJSON to unified chunk format
 * Supports multimodal messages with .images array (vision models)
 *
 * Factory-based: createStream(baseUrl) returns a stream generator.
 * The default export is for the office Ollama (100.113.43.60:11434).
 */
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://100.113.43.60:11434';

function createStream(baseUrl, providerName = 'ollama') {
  const apiBase = baseUrl || OLLAMA_URL;

  async function* stream(model, messages, options = {}, signal) {
    // Transform messages: move .images to Ollama's expected format
    const ollamaMessages = messages.map(msg => {
      const m = { role: msg.role, content: msg.content };
      if (msg.images && msg.images.length > 0) {
        m.images = msg.images.map(img => img.data);
      }
      return m;
    });

    const body = {
      model,
      messages: ollamaMessages,
      stream: true,
      keep_alive: '30m',
      options: {},
    };
    if (options.temperature !== undefined) body.options.temperature = options.temperature;
    if (options.think) body.think = true;

    const res = await fetch(`${apiBase}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${res.status}: ${text}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let accumulated = '';

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
            yield { type: 'chunk', content: data.message.content };
          }
          if (data.done) {
            yield {
              type: 'done',
              content: accumulated,
              meta: {
                provider: providerName,
                model,
                tokens_eval: data.eval_count || 0,
                tokens_prompt: data.prompt_eval_count || 0,
                duration_ms: Math.round((data.total_duration || 0) / 1e6),
                eval_duration_ms: Math.round((data.eval_duration || 0) / 1e6),
              },
            };
          }
        } catch {}
      }
    }
  }

  return { stream };
}

// Default: office Ollama (backward compatible)
module.exports = { stream: createStream().stream, createStream };
