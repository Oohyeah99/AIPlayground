/**
 * AI Playground — Express backend
 *
 * Serves the static frontend, proxies requests to Ollama & ComfyUI
 * (solving CORS), and persists conversations + generated media to SQLite.
 * Unified /api/chat endpoint for Ollama, OpenAI, and Gemini.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const path = require('path');
const fs = require('fs');
let Database;
try {
  Database = require('better-sqlite3');
} catch (err) {
  console.error('better-sqlite3 unavailable:', err.message);
  Database = null;
}

// Provider modules
const ollamaProvider = require('./providers/ollama');
const ollamaLocalProvider = require('./providers/ollama-local');
const openaiProvider = require('./providers/openai');
const geminiProvider = require('./providers/gemini');
const deepseekProvider = require('./providers/deepseek');
const { preprocessMessages } = require('./file-utils');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3200;
const isVercel = process.env.VERCEL === '1';

// --- Config ---
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://100.113.43.60:11434';
const LOCAL_OLLAMA_URL = process.env.LOCAL_OLLAMA_URL || 'http://localhost:11434';
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://100.113.43.60:8188';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Ahyeah11!';
const dataDir = isVercel ? '/tmp/data' : path.join(__dirname, '..', 'data');
const REGISTRY_PATH = path.join(dataDir, 'model_registry.json');

// --- Auth: session tokens (in-memory, survive until server restart) ---
const validTokens = new Set();

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.add(token);
  return token;
}

function isAuthenticated(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)aip_token=([a-f0-9]+)/);
  return match && validTokens.has(match[1]);
}

// --- Login endpoint (before auth middleware) ---
app.use(express.json({ limit: '50mb' }));

app.post('/api/login', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    const token = generateToken();
    res.setHeader('Set-Cookie', `aip_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// --- Auth gate: block everything except login page + login API ---
app.use((req, res, next) => {
  if (req.path === '/api/login') return next();
  if (req.path === '/login.html') return next();
  // Allow login page static assets (CSS referenced in login.html)
  if (req.path === '/css/style.css') return next();
  if (isAuthenticated(req)) return next();
  // Not authenticated — serve login page for HTML requests, 401 for API
  if (req.path.startsWith('/api/') || req.path.startsWith('/ollama/') || req.path.startsWith('/comfyui/')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Outputs directory ---
const outputsDir = path.join(dataDir, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

// --- Model Registry Helpers ---
function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
    }
  } catch {}
  return { global_hidden: [], app_overrides: {} };
}

function saveRegistryFile(data) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2));
}

const dbPath = path.join(dataDir, 'playground.db');
let db;
if (Database) {
  try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } catch (err) {
    console.error('Database init failed:', err.message);
    db = null;
  }
}

if (!db) {
  console.warn('Using no-op database — conversations and generations will not persist');
  const noop = { changes: 0, lastInsertRowid: 0 };
  db = { exec: () => {}, pragma: () => {}, prepare: () => ({ all: () => [], run: () => noop, get: () => undefined }) };
}

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New Chat',
    model TEXT,
    system_prompt TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    provider TEXT DEFAULT 'ollama',
    tokens_eval INTEGER,
    tokens_prompt INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('image', 'video')),
    provider TEXT DEFAULT '',
    prompt TEXT NOT NULL,
    negative_prompt TEXT DEFAULT '',
    width INTEGER,
    height INTEGER,
    steps INTEGER,
    cfg REAL,
    seed INTEGER,
    filename TEXT,
    file_size INTEGER,
    duration_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'generating', 'complete', 'failed')),
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_generations_type ON generations(type, created_at);

  CREATE TABLE IF NOT EXISTS tts_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL DEFAULT 'gemini',
    voice TEXT NOT NULL DEFAULT 'Kore',
    text TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT DEFAULT 'audio/wav',
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// --- Conversation API ---

app.get('/api/conversations', (req, res) => {
  const rows = db.prepare(
    'SELECT id, title, model, system_prompt, created_at, updated_at FROM conversations ORDER BY updated_at DESC'
  ).all();
  res.json(rows);
});

app.post('/api/conversations', (req, res) => {
  const id = crypto.randomUUID();
  const { title, model, system_prompt } = req.body;
  db.prepare(
    'INSERT INTO conversations (id, title, model, system_prompt) VALUES (?, ?, ?, ?)'
  ).run(id, title || 'New Chat', model || null, system_prompt || '');
  res.status(201).json({ id, title: title || 'New Chat', model, system_prompt: system_prompt || '' });
});

app.put('/api/conversations/:id', (req, res) => {
  const { title, model, system_prompt } = req.body;
  const updates = [];
  const params = [];
  if (title !== undefined) { updates.push('title = ?'); params.push(title); }
  if (model !== undefined) { updates.push('model = ?'); params.push(model); }
  if (system_prompt !== undefined) { updates.push('system_prompt = ?'); params.push(system_prompt); }
  if (updates.length === 0) return res.json({ ok: true });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/conversations/:id/messages', (req, res) => {
  const rows = db.prepare(
    'SELECT id, role, content, model, provider, tokens_eval, tokens_prompt, duration_ms, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/conversations/:id/messages', (req, res) => {
  const { role, content, model, provider, tokens_eval, tokens_prompt, duration_ms } = req.body;
  const result = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, model, provider, tokens_eval, tokens_prompt, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, role, content, model || null, provider || 'ollama', tokens_eval || null, tokens_prompt || null, duration_ms || null);
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.status(201).json({ id: result.lastInsertRowid });
});

// --- Generation History API ---

app.get('/api/generations', (req, res) => {
  const type = req.query.type || 'image';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = db.prepare(
    'SELECT * FROM generations WHERE type = ? ORDER BY created_at DESC LIMIT ?'
  ).all(type, limit);
  res.json(rows);
});

app.post('/api/generations', (req, res) => {
  const { type, prompt, negative_prompt, width, height, steps, cfg, seed, filename, file_size, duration_ms, status, error, provider } = req.body;
  const result = db.prepare(
    `INSERT INTO generations (type, provider, prompt, negative_prompt, width, height, steps, cfg, seed, filename, file_size, duration_ms, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(type, provider || '', prompt, negative_prompt || '', width ?? null, height ?? null, steps ?? null, cfg ?? null, seed ?? null, filename ?? null, file_size ?? null, duration_ms ?? null, status || 'complete', error ?? null);
  res.status(201).json({ id: result.lastInsertRowid });
});

// --- TTS History API ---

app.get('/api/tts/history', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const rows = db.prepare(
    'SELECT * FROM tts_generations ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
  res.json(rows);
});

// --- Providers Catalog API ---

const OPENAI_MODELS = [
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano' },
  { id: 'gpt-4.1', name: 'GPT-4.1' },
  { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' },
  { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano' },
  { id: 'o3', name: 'o3 (Reasoning)' },
  { id: 'o3-pro', name: 'o3-pro (Reasoning)' },
  { id: 'o4-mini', name: 'o4-mini (Reasoning)' },
];

const GEMINI_MODELS = [
  { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro (Paid)' },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' },
];

const DEEPSEEK_MODELS = [
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (Reasoning)' },
  { id: 'deepseek-chat', name: 'DeepSeek Chat (V4 Flash non-thinking)' },
  { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (V4 Flash thinking)' },
];

// Apply registry filtering to a providers list
// If appName is provided, app-specific overrides take precedence over global hidden.
// If appName is null/undefined, only global_hidden is applied.
function applyRegistryFilter(providers, appName) {
  const registry = loadRegistry();
  const globalHidden = new Set(registry.global_hidden || []);
  const overrides = registry.app_overrides || {};

  for (const prov of providers) {
    prov.models = prov.models.filter(m => {
      const key = `${prov.id}/${m.id}`;
      // App-specific override takes precedence
      if (appName && overrides[key] && overrides[key][appName] !== undefined) {
        return overrides[key][appName];
      }
      // Check global hidden
      return !globalHidden.has(key);
    });
  }
}

app.get('/api/providers', async (req, res) => {
  const providers = [];

  // Ollama (Laptop) — localhost:11434
  try {
    const localRes = await fetch(`${LOCAL_OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const localData = await localRes.json();
    providers.push({
      id: 'ollama-local', name: 'Ollama (Laptop)', status: 'online',
      models: (localData.models || []).map(m => ({
        id: m.name, name: m.name, size: m.details?.parameter_size || '',
      })),
    });
  } catch {
    providers.push({ id: 'ollama-local', name: 'Ollama (Laptop)', status: 'offline', models: [] });
  }

  // Ollama (Office 4090) — 100.113.43.60:11434
  try {
    const ollamaRes = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = await ollamaRes.json();
    providers.push({
      id: 'ollama', name: 'Ollama (Office 4090)', status: 'online',
      models: (data.models || []).map(m => ({
        id: m.name, name: m.name, size: m.details?.parameter_size || '',
      })),
    });
  } catch {
    providers.push({ id: 'ollama', name: 'Ollama (Office 4090)', status: 'offline', models: [] });
  }

  // OpenAI
  providers.push({
    id: 'openai', name: 'OpenAI',
    status: process.env.OPENAI_API_KEY ? 'ready' : 'no_key',
    models: OPENAI_MODELS,
  });

  // Gemini
  providers.push({
    id: 'gemini', name: 'Google Gemini',
    status: process.env.GEMINI_API_KEY ? 'ready' : 'no_key',
    models: GEMINI_MODELS,
  });

  // DeepSeek
  providers.push({
    id: 'deepseek', name: 'DeepSeek',
    status: process.env.DEEPSEEK_API_KEY ? 'ready' : 'no_key',
    models: DEEPSEEK_MODELS,
  });

  // Apply per-app visibility filtering if ?app= is provided
  // (settings page omits ?app= to see all models for the matrix)
  if (req.query.app) {
    applyRegistryFilter(providers, req.query.app);
  }

  res.json({ providers });
});

// --- API Model Discovery ---

let _discoveryCache = null;
let _discoveryCacheTime = 0;
const DISCOVERY_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function discoverApiModels(force = false) {
  if (!force && _discoveryCache && (Date.now() - _discoveryCacheTime) < DISCOVERY_CACHE_TTL) {
    return _discoveryCache;
  }

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

  _discoveryCache = result;
  _discoveryCacheTime = Date.now();
  return result;
}

app.get('/api/models/discover', async (req, res) => {
  const force = req.query.force === 'true';
  const models = await discoverApiModels(force);
  res.json(models);
});

// --- Model Visibility Registry ---

app.get('/api/models/registry', (req, res) => {
  res.json(loadRegistry());
});

app.put('/api/models/registry', (req, res) => {
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid registry data' });
  }
  saveRegistryFile(data);
  res.json({ ok: true });
});

// --- Unified Chat Streaming API ---

const PROVIDERS = { 'ollama-local': ollamaLocalProvider, ollama: ollamaProvider, openai: openaiProvider, gemini: geminiProvider, deepseek: deepseekProvider };

app.post('/api/chat', async (req, res) => {
  const { provider: providerName, model, messages, options } = req.body;
  const providerModule = PROVIDERS[providerName];
  if (!providerModule) {
    return res.status(400).json({ error: `Unknown provider: ${providerName}` });
  }

  // Preprocess attachments (extract doc text, normalize images)
  let processedMessages;
  try {
    processedMessages = await preprocessMessages(messages);
  } catch (err) {
    return res.status(400).json({ error: `Attachment processing failed: ${err.message}` });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  try {
    for await (const chunk of providerModule.stream(model, processedMessages, options || {}, ac.signal)) {
      if (res.writableEnded) break;
      res.write(JSON.stringify(chunk) + '\n');
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      const errChunk = { type: 'error', message: err.message };
      if (!res.writableEnded) res.write(JSON.stringify(errChunk) + '\n');
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

// --- PCM to WAV conversion ---
// Gemini TTS returns raw PCM (audio/L16) which browsers can't play.
// This wraps it in a RIFF/WAV header so <audio> elements can decode it.
function pcmToWav(pcmBase64, sampleRate = 24000, bitsPerSample = 16, numChannels = 1) {
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const dataLength = pcmBuffer.length;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, pcmBuffer]).toString('base64');
}

// --- Text-to-Speech API (multi-provider: Gemini + OpenAI) ---

async function geminiTTS(text, voice, language_code, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured');

  const model = 'gemini-2.5-flash-preview-tts';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

  const contents = [{ parts: [{ text }] }];
  const generationConfig = {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: voice || 'Kore' },
      },
    },
  };
  if (language_code) generationConfig.speechConfig.languageCode = language_code;

  const body = { contents, generationConfig };
  if (prompt) body.systemInstruction = { parts: [{ text: prompt }] };

  // Retry once on 429 (rate limit) — wait the specified time
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });

    if (apiRes.status === 429 && attempt === 0) {
      const errBody = await apiRes.text();
      const retryMatch = errBody.match(/retry in ([\d.]+)s/i);
      const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) + 1 : 25;
      lastError = `Rate limited, waiting ${waitSec}s...`;
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      throw new Error(`Gemini TTS ${apiRes.status}: ${errText}`);
    }

    const data = await apiRes.json();
    const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (!audioData) throw new Error('No audio data in Gemini response');

    let audioBase64 = audioData.data;
    let mimeType = audioData.mimeType || 'audio/wav';

    if (mimeType.includes('L16') || mimeType.includes('pcm') || mimeType.includes('raw')) {
      const sampleRate = parseInt((mimeType.match(/rate=(\d+)/) || [])[1] || '24000');
      audioBase64 = pcmToWav(audioBase64, sampleRate);
      mimeType = 'audio/wav';
    }

    return { audio: audioBase64, mimeType };
  }
  throw new Error(lastError || 'Gemini TTS failed after retries');
}

async function openaiTTS(text, voice, speed) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not configured');

  const apiRes = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: 'tts-1-hd',
      input: text,
      voice: voice || 'alloy',
      response_format: 'mp3',
      speed: speed || 1.0,
    }),
    signal: AbortSignal.timeout(90000),
  });

  if (!apiRes.ok) {
    const errText = await apiRes.text();
    throw new Error(`OpenAI TTS ${apiRes.status}: ${errText}`);
  }

  const buffer = Buffer.from(await apiRes.arrayBuffer());
  return { audio: buffer.toString('base64'), mimeType: 'audio/mp3' };
}

app.post('/api/tts', async (req, res) => {
  const { text, voice, language_code, prompt, provider, speed } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  const startTime = Date.now();
  try {
    let result;
    if (provider === 'openai') {
      result = await openaiTTS(text, voice, speed);
    } else {
      result = await geminiTTS(text, voice, language_code, prompt);
    }

    const actualVoice = voice || (provider === 'openai' ? 'alloy' : 'Kore');
    const actualProvider = provider || 'gemini';
    const ext = result.mimeType.includes('mp3') ? 'mp3' : 'wav';
    const filename = `tts-${actualVoice}-${Date.now()}.${ext}`;

    // Save audio file to disk
    const filePath = path.join(outputsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(result.audio, 'base64'));

    // Save to DB for persistence
    const duration = Date.now() - startTime;
    db.prepare(
      'INSERT INTO tts_generations (provider, voice, text, filename, mime_type, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(actualProvider, actualVoice, text, filename, result.mimeType, duration);

    res.json({
      audio: result.audio,
      mimeType: result.mimeType,
      text,
      voice: actualVoice,
      provider: actualProvider,
      filename,
    });
  } catch (err) {
    res.status(500).json({ error: `TTS failed: ${err.message}` });
  }
});

// --- Imagen (Google image generation) ---

app.post('/api/imagen', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { prompt, model, aspectRatio, sampleCount } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const modelId = model || 'imagen-4.0-fast-generate-001';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predict`;

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
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

    // Save first image to disk
    const imgBase64 = predictions[0].bytesBase64Encoded;
    const mimeType = predictions[0].mimeType || 'image/png';
    const ext = mimeType.includes('jpeg') ? 'jpg' : 'png';
    const filename = `imagen-${Date.now()}.${ext}`;
    const filePath = path.join(outputsDir, filename);
    fs.writeFileSync(filePath, Buffer.from(imgBase64, 'base64'));

    res.json({
      images: predictions.map(p => ({
        base64: p.bytesBase64Encoded,
        mimeType: p.mimeType || 'image/png',
      })),
      filename,
      model: modelId,
    });
  } catch (err) {
    res.status(500).json({ error: `Imagen failed: ${err.message}` });
  }
});

// --- Veo (Google video generation) ---

app.post('/api/veo', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { prompt, model, aspectRatio, durationSeconds } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  const modelId = model || 'veo-3.1-fast-generate-preview';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:predictLongRunning`;

  try {
    const apiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': key,
      },
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
    // Returns { name: "operations/...", ... }
    res.json({ operation: data.name, model: modelId });
  } catch (err) {
    res.status(500).json({ error: `Veo submit failed: ${err.message}` });
  }
});

app.get('/api/veo/status', async (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const opName = req.query.operation;
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
      // Extract video URI and download it
      const samples = data.response?.generateVideoResponse?.generatedSamples || [];
      if (samples.length && samples[0].video?.uri) {
        const videoUri = samples[0].video.uri;
        // Download the video and save locally
        const vidRes = await fetch(videoUri, {
          headers: { 'x-goog-api-key': key },
          signal: AbortSignal.timeout(120000),
        });
        if (vidRes.ok) {
          const buffer = Buffer.from(await vidRes.arrayBuffer());
          const filename = `veo-${Date.now()}.mp4`;
          const filePath = path.join(outputsDir, filename);
          fs.writeFileSync(filePath, buffer);
          return res.json({ done: true, filename, fileSize: buffer.length });
        }
      }
      // If we can't download, still report done
      return res.json({ done: true, error: 'Could not download video' });
    }

    // Still processing
    res.json({ done: false, metadata: data.metadata });
  } catch (err) {
    res.status(500).json({ error: `Veo poll failed: ${err.message}` });
  }
});

// --- Local Ollama Proxy (KL's laptop localhost:11434) ---

app.all('/local-ollama/*path', async (req, res) => {
  const segments = req.params.path;
  const targetPath = Array.isArray(segments) ? segments.join('/') : String(segments);
  const url = `${LOCAL_OLLAMA_URL}/${targetPath}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, fetchOpts);

    if (req.body?.stream && upstream.body) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(value);
        }
      };
      pump().catch(() => res.end());
      return;
    }

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: `Local Ollama proxy error: ${err.message}` });
  }
});

// --- Ollama Proxy (solves CORS) ---

app.all('/ollama/*path', async (req, res) => {
  const segments = req.params.path;
  const targetPath = Array.isArray(segments) ? segments.join('/') : String(segments);
  const url = `${OLLAMA_URL}/${targetPath}`;

  try {
    const fetchOpts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, fetchOpts);

    // For streaming responses (chat with stream:true)
    if (req.body?.stream && upstream.body) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); return; }
          res.write(value);
        }
      };
      pump().catch(() => res.end());
      return;
    }

    // Non-streaming
    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json').send(data);
  } catch (err) {
    res.status(502).json({ error: `Ollama proxy error: ${err.message}` });
  }
});

// --- ComfyUI Proxy (solves CORS) ---

app.all('/comfyui/*path', async (req, res) => {
  const segments = req.params.path;
  const targetPath = Array.isArray(segments) ? segments.join('/') : String(segments);
  const queryString = new URLSearchParams(req.query).toString();
  const url = `${COMFYUI_URL}/${targetPath}${queryString ? '?' + queryString : ''}`;

  try {
    const fetchOpts = { method: req.method };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, fetchOpts);
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    // Binary responses (images, videos)
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType === 'application/octet-stream') {
      const buffer = await upstream.arrayBuffer();
      res.status(upstream.status).setHeader('Content-Type', contentType).send(Buffer.from(buffer));
      return;
    }

    const data = await upstream.text();
    res.status(upstream.status).setHeader('Content-Type', contentType).send(data);
  } catch (err) {
    res.status(502).json({ error: `ComfyUI proxy error: ${err.message}` });
  }
});

// --- Generated media static files ---
app.use('/outputs', express.static(path.join(__dirname, '..', 'data', 'outputs')));

// --- SPA fallback ---
app.get('/*path', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// --- Start ---
if (isVercel) {
  const serverless = require('serverless-http');
  module.exports = serverless(app);
} else {
  app.listen(PORT, () => {
    console.log(`AI Playground running at http://localhost:${PORT}`);
    console.log(`Ollama (laptop): ${LOCAL_OLLAMA_URL}`);
    console.log(`Ollama (office): ${OLLAMA_URL}`);
    console.log(`ComfyUI proxy: ${COMFYUI_URL}`);
  });
}
