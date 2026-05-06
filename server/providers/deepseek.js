/**
 * DeepSeek streaming provider — OpenAI-compatible with reasoning_content support
 * Handles both thinking (reasoning_content) and regular (content) delta fields.
 */
const DEEPSEEK_API_KEY = () => process.env.DEEPSEEK_API_KEY;

async function* stream(model, messages, options = {}, signal) {
  const key = DEEPSEEK_API_KEY();
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured');

  // Transform messages: convert .images to OpenAI content array format
  const dsMessages = messages.map(msg => {
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
    messages: dsMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.temperature !== undefined) body.temperature = options.temperature;

  const startTime = Date.now();

  const res = await fetch('https://api.deepseek.com/chat/completions', {
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
    throw new Error(`DeepSeek ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let reasoning = '';
  let hasReasoning = false;
  let reasoningDone = false;
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
        // If there was reasoning but no content, use reasoning as the output
        const finalContent = accumulated || reasoning;
        yield {
          type: 'done',
          content: finalContent,
          meta: {
            provider: 'deepseek',
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
        if (data.usage) {
          usage = data.usage;
        }

        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;

        // Handle reasoning_content (thinking tokens)
        if (delta.reasoning_content) {
          if (!hasReasoning) {
            hasReasoning = true;
            const marker = '<think>\n';
            reasoning += marker;
            yield { type: 'chunk', content: marker };
          }
          reasoning += delta.reasoning_content;
          yield { type: 'chunk', content: delta.reasoning_content };
        }

        // Handle regular content
        if (delta.content) {
          if (hasReasoning && !reasoningDone) {
            reasoningDone = true;
            const marker = '\n</think>\n\n';
            reasoning += marker;
            yield { type: 'chunk', content: marker };
          }
          accumulated += delta.content;
          yield { type: 'chunk', content: delta.content };
        }
      } catch {}
    }
  }

  // If stream ended without [DONE]
  const finalContent = accumulated || reasoning;
  if (finalContent) {
    yield {
      type: 'done',
      content: finalContent,
      meta: {
        provider: 'deepseek',
        model,
        tokens_eval: usage?.completion_tokens || 0,
        tokens_prompt: usage?.prompt_tokens || 0,
        duration_ms: Date.now() - startTime,
      },
    };
  }
}

module.exports = { stream };
