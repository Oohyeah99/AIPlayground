# AI Playground — Agent Instructions

## Project Overview
Unified web interface for all open-source AI models running on the office 4090 GPU. Provides chat (Ollama LLMs), image generation (Flux via ComfyUI), video generation (HunyuanVideo via ComfyUI), and model management — all from a single dark-themed dashboard.

**URL:** ai.kreativeland.com (pending deployment)
**Local dev:** http://localhost:3200
**Tech:** Express 5, Node.js built-in SQLite (`node:sqlite`), vanilla JS frontend
**Ecosystem:** KreativeLand portal card links here

## Architecture

```
Browser (localhost:3200)
  ├── /ollama/*   → Express proxy → http://100.113.43.60:11434 (Ollama)
  ├── /comfyui/*  → Express proxy → http://100.113.43.60:8188 (ComfyUI)
  ├── /api/*      → Express REST API → SQLite (conversations, generations)
  └── /*          → Static files (public/)
```

## Commands

```bash
npm install          # Install dependencies (Express only, no native modules)
npm run dev          # Start with --watch (auto-restart on changes)
npm start            # Production start
```

Server runs on port 3200 by default. Set `PORT`, `OLLAMA_URL`, `COMFYUI_URL` env vars to override.

## Directory Structure

```
AIPlayground/
├── server/
│   └── index.js          # Express backend: proxy, SQLite, REST API
├── public/
│   ├── index.html        # App shell: 4 tabs (Chat, Image, Video, Models)
│   ├── css/style.css     # Design system (dark theme, KreativeLand tokens)
│   └── js/
│       ├── api.js        # Shared API client (Ollama, ComfyUI, local backend)
│       ├── app.js        # Tab navigation, status bar, model selector
│       ├── chat.js       # Chat module: streaming, markdown, conversations
│       ├── image.js      # Flux image generation via ComfyUI
│       ├── video.js      # HunyuanVideo video generation via ComfyUI
│       └── models.js     # GPU status, model list, pull/delete
├── data/
│   ├── playground.db     # SQLite database (auto-created)
│   └── outputs/          # Downloaded generated media
├── package.json
└── .gitignore
```

## Key Design Decisions

1. **No build step** — vanilla JS with IIFE modules, CDN for marked.js and highlight.js
2. **Node.js built-in SQLite** — `node:sqlite` (requires Node >= 22.5), no native compilation needed
3. **Express 5** — uses path-to-regexp v8 (`*path` wildcards return arrays, join with `/`)
4. **Proxy pattern** — browser hits `/ollama/*` and `/comfyui/*`, Express forwards to the GPU machine. Solves CORS without touching upstream services
5. **Streaming chat** — Ollama NDJSON stream piped through Express to browser `ReadableStream`

## ComfyUI Workflow Models

Image generation (Flux) expects these files in ComfyUI:
- `diffusion_models/flux1-dev.safetensors`
- `text_encoders/t5xxl_fp16.safetensors`
- `text_encoders/clip_l.safetensors`
- `vae/ae.safetensors`

Video generation (HunyuanVideo) expects:
- `diffusion_models/hunyuan_video_720_cfgdistill_fp8_e4m3fn.safetensors`
- `text_encoders/clip_l.safetensors`
- `text_encoders/llava_llama3_fp8_scaled.safetensors`
- `vae/hunyuan_video_vae_bf16.safetensors`

## Quest Status

**Quest:** AI Playground (managed by Qoder Admin)
**Status:** v1.0 built and tested locally (2026-04-20)
**Pending:** Portal card, deployment to ai.kreativeland.com
