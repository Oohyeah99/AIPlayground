/**
 * AI Playground — Express backend
 *
 * Serves the static frontend, proxies requests to Ollama & ComfyUI
 * (solving CORS), and persists conversations + generated media to SQLite.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const app = express();
const PORT = process.env.PORT || 3200;

// --- Config ---
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://100.113.43.60:11434';
const COMFYUI_URL = process.env.COMFYUI_URL || 'http://100.113.43.60:8188';

// --- Middleware ---
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Database ---
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const outputsDir = path.join(dataDir, 'outputs');
if (!fs.existsSync(outputsDir)) fs.mkdirSync(outputsDir, { recursive: true });

const dbPath = path.join(dataDir, 'playground.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

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
    tokens_eval INTEGER,
    tokens_prompt INTEGER,
    duration_ms INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('image', 'video')),
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
    'SELECT id, role, content, tokens_eval, tokens_prompt, duration_ms, created_at FROM messages WHERE conversation_id = ? ORDER BY id'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/conversations/:id/messages', (req, res) => {
  const { role, content, tokens_eval, tokens_prompt, duration_ms } = req.body;
  const result = db.prepare(
    'INSERT INTO messages (conversation_id, role, content, tokens_eval, tokens_prompt, duration_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(req.params.id, role, content, tokens_eval || null, tokens_prompt || null, duration_ms || null);
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
  const { type, prompt, negative_prompt, width, height, steps, cfg, seed, filename, file_size, duration_ms, status, error } = req.body;
  const result = db.prepare(
    `INSERT INTO generations (type, prompt, negative_prompt, width, height, steps, cfg, seed, filename, file_size, duration_ms, status, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(type, prompt, negative_prompt || '', width, height, steps, cfg, seed, filename, file_size, duration_ms, status || 'complete', error || null);
  res.status(201).json({ id: result.lastInsertRowid });
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
app.listen(PORT, () => {
  console.log(`AI Playground running at http://localhost:${PORT}`);
  console.log(`Ollama proxy: ${OLLAMA_URL}`);
  console.log(`ComfyUI proxy: ${COMFYUI_URL}`);
});
