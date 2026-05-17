/**
 * AI Playground — Vercel Serverless Function (Node.js runtime)
 *
 * Lightweight proxy for cloud-only APIs (Imagen, OpenAI, Gemini, DeepSeek).
 * NO SQLite, NO Tailscale, NO Ollama, NO ComfyUI — those stay on the Azure VM.
 *
 * This solves the Imagen geographic restriction by routing Google API calls
 * through Vercel's US-based edge network.
 */

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const path = req.url.split('?')[0];

  // Route: POST /api/imagen
  if (path === '/api/imagen' && req.method === 'POST') {
    return handleImagen(req, res);
  }

  // Route: POST /api/chat (OpenAI, Gemini, DeepSeek only)
  if (path === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const provider = parsed.provider;
        if (provider === 'openai') return handleOpenAIChat(parsed, res);
        if (provider === 'gemini') return handleGeminiChat(parsed, res);
        if (provider === 'deepseek') return handleDeepSeekChat(parsed, res);
        res.status(400).json({ error: `Provider ${provider} not supported on Vercel` });
      } catch (e) {
        res.status(400).json({ error: 'Invalid JSON body' });
      }
    });
    return;
  }

  // Route: POST /api/veo (Veo video generation - submit)
  if (path === '/api/veo' && req.method === 'POST') {
    return handleVeoSubmit(req, res);
  }

  // Route: GET /api/veo/status (Veo video generation - poll)
  if (path === '/api/veo/status' && req.method === 'GET') {
    return handleVeoPoll(req, res);
  }

  // Route: POST /api/dalle (DALL-E 3 image generation)
  if (path === '/api/dalle' && req.method === 'POST') {
    return handleDalle(req, res);
  }

  // Route: GET /api/models/discover (fetch model lists from OpenAI, Gemini, DeepSeek)
  if (path === '/api/models/discover' && req.method === 'GET') {
    return handleModelDiscovery(req, res);
  }

  // Route: GET /api/health
  if (path === '/api/health' && req.method === 'GET') {
    return res.json({ status: 'ok', platform: 'vercel-node' });
  }

  // Catch-all
  res.status(404).json({ error: 'Not found on Vercel. Use Azure VM for Ollama, ComfyUI, and other features.' });
};

// --- Imagen (Google image generation) ---
async function handleImagen(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body);
      const { prompt, model, aspectRatio, sampleCount } = parsed;
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      const modelId = model || 'imagen-4.0-fast-generate-001';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predict`;

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            sampleCount: sampleCount || 1,
            aspectRatio: aspectRatio || '1:1',
            personGeneration: 'allow_adult',
          },
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        return res.status(apiRes.status).json({ error: `Imagen ${apiRes.status}: ${errText}` });
      }

      const data = await apiRes.json();
      const predictions = data.predictions || [];
      if (!predictions.length) return res.status(500).json({ error: 'No images in response' });

      res.json({
        images: predictions.map(p => ({ base64: p.bytesBase64Encoded, mimeType: p.mimeType || 'image/png' })),
        model: modelId,
      });
    } catch (e) {
      res.status(500).json({ error: `Imagen failed: ${e.message}` });
    }
  });
}

// --- OpenAI Chat (streaming) ---
async function handleOpenAIChat(body, res) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  const { model, messages, options } = body;

  const apiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    return res.status(apiRes.status).json({ error: `OpenAI ${apiRes.status}: ${errText}` });
  }

  // Set streaming headers
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Proxy the OpenAI stream
  const reader = apiRes.body.getReader();
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
      if (line === 'data: [DONE]') {
        res.write(JSON.stringify({ type: 'done', content: accumulated, meta: {} }) + '\n');
        break;
      }
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          const content = data.choices?.[0]?.delta?.content;
          if (content) {
            accumulated += content;
            res.write(JSON.stringify({ type: 'chunk', content }) + '\n');
          }
        } catch {}
      }
    }
  }
  res.end();
}

// --- Gemini Chat (non-streaming) ---
async function handleGeminiChat(body, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { model, messages, options } = body;

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const systemInstruction = messages.find(m => m.role === 'system');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const apiRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents,
      systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined,
      generationConfig: {
        temperature: options?.temperature ?? 0.7,
      },
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    return res.status(apiRes.status).json({ error: `Gemini ${apiRes.status}: ${errText}` });
  }

  const data = await apiRes.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const usage = data.usageMetadata || {};

  res.json({
    type: 'done',
    content,
    meta: {
      tokens_prompt: usage.promptTokenCount || 0,
      tokens_eval: usage.candidatesTokenCount || 0,
    },
  });
}

// --- Veo (Google video generation) ---
async function handleVeoSubmit(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body);
      const { prompt, model, aspectRatio, durationSeconds } = parsed;
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      const modelId = model || 'veo-3.1-fast-generate-preview';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning`;

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: {
            aspectRatio: aspectRatio || '16:9',
            durationSeconds: durationSeconds || 8,
          },
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        return res.status(apiRes.status).json({ error: `Veo ${apiRes.status}: ${errText}` });
      }

      const data = await apiRes.json();
      res.json({ operation: data.name, model: modelId });
    } catch (e) {
      res.status(500).json({ error: `Veo submit failed: ${e.message}` });
    }
  });
}

async function handleVeoPoll(req, res) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const urlObj = new URL(req.url, 'https://placeholder');
  const opName = urlObj.searchParams.get('operation');
  if (!opName) return res.status(400).json({ error: 'operation query param required' });

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/${opName}`;
    const apiRes = await fetch(url, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(15000),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return res.status(apiRes.status).json({ error: `Veo poll ${apiRes.status}: ${errText}` });
    }

    const data = await apiRes.json();
    if (data.done) {
      const samples = data.response?.generateVideoResponse?.generatedSamples || [];
      if (samples.length && samples[0].video?.uri) {
        const videoUri = samples[0].video.uri;
        const vidRes = await fetch(videoUri, {
          headers: { 'x-goog-api-key': key },
          signal: AbortSignal.timeout(120000),
        });
        if (vidRes.ok) {
          const buffer = Buffer.from(await vidRes.arrayBuffer());
          return res.json({ done: true, videoBase64: buffer.toString('base64'), videoMimeType: 'video/mp4', fileSize: buffer.length });
        }
      }
      return res.json({ done: true, error: 'Could not download video from Google' });
    }

    res.json({ done: false, metadata: data.metadata });
  } catch (e) {
    res.status(500).json({ error: `Veo poll failed: ${e.message}` });
  }
}

// --- DALL-E 3 (OpenAI image generation) ---
async function handleDalle(req, res) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const parsed = JSON.parse(body);
      const { prompt, model, aspectRatio } = parsed;
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });

      // Map aspect ratio to DALL-E 3 supported sizes
      const sizeMap = {
        '1:1': '1024x1024',
        '16:9': '1792x1024',
        '9:16': '1024x1792',
      };
      const size = sizeMap[aspectRatio] || '1024x1024';

      const apiRes = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: model || 'gpt-image-1',
          prompt,
          n: 1,
          size,
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        return res.status(apiRes.status).json({ error: `DALL-E ${apiRes.status}: ${errText}` });
      }

      const data = await apiRes.json();
      const img = data.data?.[0];
      if (!img) return res.status(500).json({ error: 'No image in response' });

      res.json({
        imageBase64: img.b64_json || null,
        imageUrl: img.url || null,
        model: model || 'gpt-image-1',
        size,
      });
    } catch (e) {
      res.status(500).json({ error: `DALL-E failed: ${e.message}` });
    }
  });
}

// --- Model Discovery (OpenAI, Gemini, DeepSeek model lists) ---
async function handleModelDiscovery(req, res) {
  const result = { openai: [], gemini: [], deepseek: [], discovered_at: new Date().toISOString() };

  // OpenAI — GET /v1/models
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const data = await r.json();
        result.openai = (data.data || [])
          .map(m => ({ id: m.id, name: m.id, owned_by: m.owned_by }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
    } catch {}
  }

  // Gemini — GET /v1beta/models
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}&pageSize=200`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (r.ok) {
        const data = await r.json();
        result.gemini = (data.models || [])
          .map(m => ({
            id: m.name.replace('models/', ''),
            name: m.displayName || m.name.replace('models/', ''),
            description: m.description || '',
            inputTokenLimit: m.inputTokenLimit,
            outputTokenLimit: m.outputTokenLimit,
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
    } catch {}
  }

  // DeepSeek — GET /models
  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const r = await fetch('https://api.deepseek.com/models', {
        headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const data = await r.json();
        result.deepseek = (data.data || [])
          .map(m => ({ id: m.id, name: m.id, owned_by: m.owned_by }))
          .sort((a, b) => a.id.localeCompare(b.id));
      }
    } catch {}
  }

  res.json(result);
}

// --- DeepSeek Chat (streaming) ---
async function handleDeepSeekChat(body, res) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return res.status(500).json({ error: 'DEEPSEEK_API_KEY not configured' });

  const { model, messages, options } = body;

  const apiRes = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: options?.temperature ?? 0.7,
    }),
    signal: AbortSignal.timeout(120000),
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    return res.status(apiRes.status).json({ error: `DeepSeek ${apiRes.status}: ${errText}` });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Transfer-Encoding', 'chunked');

  const reader = apiRes.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let accumulated = '';
  let meta = {};

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line === 'data: [DONE]') {
        res.write(JSON.stringify({ type: 'done', content: accumulated, meta }) + '\n');
        break;
      }
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6));
          const content = data.choices?.[0]?.delta?.content;
          if (content) {
            accumulated += content;
            res.write(JSON.stringify({ type: 'chunk', content }) + '\n');
          }
          if (data.usage) {
            meta = {
              tokens_prompt: data.usage.prompt_tokens || 0,
              tokens_eval: data.usage.completion_tokens || 0,
            };
          }
        } catch {}
      }
    }
  }
  res.end();
}
