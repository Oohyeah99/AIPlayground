/**
 * OpenAI streaming provider — translates SSE to unified chunk format
 * Supports multimodal messages with .images array (vision models)
 */
const OPENAI_API_KEY = () => process.env.OPENAI_API_KEY;

async function* stream(model, messages, options = {}, signal) {
  const key = OPENAI_API_KEY();
  if (!key) throw new Error('OPENAI_API_KEY not configured');

  // Transform messages: convert .images to OpenAI content array format
  const openaiMessages = messages.map(msg => {
    if (msg.images && msg.images.length > 0) {
      const content = [{ type: 'text', text: msg.content }];
      for (const img of msg.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mime};base64,${img.data}` },
        });
      }
      return { role: msg.role, content };
    }
    return { role: msg.role, content: msg.content };
  });

  const body = {
    model,
    messages: openaiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const startTime = Date.now();

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;
      const payload = trimmed.slice(6);

      if (payload === '[DONE]') {
        yield {
          type: 'done',
          content: accumulated,
          meta: {
            provider: 'openai',
            model,
            tokens_eval: usage?.completion_tokens || 0,
            tokens_prompt: usage?.prompt_tokens || 0,
            duration_ms: Date.now() - startTime,
          },
        };
        return;
      }

      try {
        const data = JSON.parse(payload);
        // Capture usage from the final chunk (stream_options: include_usage)
        if (data.usage) {
          usage = data.usage;
        }
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) {
          accumulated += delta;
          yield { type: 'chunk', content: delta };
        }
      } catch {}
    }
  }

  // If stream ended without [DONE] (shouldn't happen but be safe)
  if (accumulated) {
    yield {
      type: 'done',
      content: accumulated,
      meta: {
        provider: 'openai',
        model,
        tokens_eval: usage?.completion_tokens || 0,
        tokens_prompt: usage?.prompt_tokens || 0,
        duration_ms: Date.now() - startTime,
      },
    };
  }
}

module.exports = { stream };
