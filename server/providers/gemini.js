/**
 * Google Gemini streaming provider — translates SSE to unified chunk format
 * Supports multimodal messages with .images array
 */
const GEMINI_API_KEY = () => process.env.GEMINI_API_KEY;

async function* stream(model, messages, options = {}, signal) {
  const key = GEMINI_API_KEY();
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  // Convert OpenAI-style messages to Gemini format (with image support)
  const contents = [];
  let systemInstruction = null;

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemInstruction = { parts: [{ text: msg.content }] };
    } else {
      const parts = [{ text: msg.content }];
      // Add images as inlineData parts
      if (msg.images && msg.images.length > 0) {
        for (const img of msg.images) {
          parts.push({
            inlineData: { mimeType: img.mime, data: img.data },
          });
        }
      }
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts,
      });
    }
  }

  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (options.temperature !== undefined) {
    body.generationConfig = { temperature: options.temperature };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
  const startTime = Date.now();

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini ${res.status}: ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let usageMeta = null;

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

      try {
        const data = JSON.parse(payload);
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) {
          accumulated += text;
          yield { type: 'chunk', content: text };
        }
        // Gemini sends usageMetadata in chunks (final one has the totals)
        if (data.usageMetadata) {
          usageMeta = data.usageMetadata;
        }
      } catch {}
    }
  }

  yield {
    type: 'done',
    content: accumulated,
    meta: {
      provider: 'gemini',
      model,
      tokens_eval: usageMeta?.candidatesTokenCount || 0,
      tokens_prompt: usageMeta?.promptTokenCount || 0,
      duration_ms: Date.now() - startTime,
    },
  };
}

module.exports = { stream };
