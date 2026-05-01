# AI Playground — Agent Instructions

## Skills Reference

Before performing tasks related to Microsoft To Do, git, the office PC, or the Azure VM, you MUST read the corresponding skill document first. Skills are at `D:\Projects\KreativeLand\SKILL-*.md`.

| Skill | File | Use When |
|-------|------|----------|
| Microsoft To Do | `SKILL-microsoft-todo.md` | Tasks, token refresh, Scott assignments |
| Office PC | `SKILL-office-pc.md` | Ollama on office PC, ComfyUI, hardware specs |
| Git Workflow | `SKILL-git-workflow.md` | Commits, push, repo setup, git issues |
| Azure VM | `SKILL-azure-vm.md` | VocabVista deployment, nginx, database, SSH |

### Backup Rule
After updating this AGENTS.md, copy it to `D:\OneDrive\AI\Qoder Workspace\KL-Quest-Docs\AGENTS\AIPlayground-AGENTS.md`. This keeps a backup copy in KL's OneDrive for easy browsing and survives laptop loss.

### Notification Rule (MANDATORY)
After making significant changes to this AGENTS.md, you MUST explicitly tell KL that: (a) this AGENTS.md has been updated, AND (b) the OneDrive backup copy has been updated. Do not wait for KL to ask.

## Project Overview
Unified web interface for AI model interaction. Supports multi-provider LLM chat (Ollama local, OpenAI GPT-5.4 series, Google Gemini), image generation (Flux via ComfyUI), video generation (HunyuanVideo via ComfyUI), text-to-speech (Gemini 3.1 Flash TTS), and model management — all from a single dark-themed dashboard.

**URL:** ai.kreativeland.com (pending deployment)
**Local dev:** http://localhost:3200
**Tech:** Express 5, Node.js built-in SQLite (`node:sqlite`), vanilla JS frontend
**Ecosystem:** KreativeLand portal card links here

## Architecture

```
Browser (localhost:3200)
  ├── /ollama/*   → Express proxy → http://100.113.43.60:11434 (Ollama)
  ├── /comfyui/*  → Express proxy → http://100.113.43.60:8188 (ComfyUI)
  ├── /api/chat   → Unified streaming endpoint (Ollama, OpenAI, Gemini)
  ├── /api/tts    → Gemini 3.1 Flash TTS (text-to-speech)
  ├── /api/*      → Express REST API → SQLite (conversations, generations)
  └── /*          → Static files (public/)
```

## LLM Providers

| Provider | Models | Auth | Notes |
|----------|--------|------|-------|
| **Ollama (Local)** | gemma4:26b, qwen3.6:35b-a3b, glm-4.7-flash, + 8 more | None (Tailscale) | Free, fast, runs on office 4090 |
| **OpenAI** | GPT-5.4, GPT-5.4 Mini, GPT-5.4 Nano, GPT-4.1, GPT-4.1 Mini, GPT-4.1 Nano, o3, o3-pro, o4-mini | `OPENAI_API_KEY` in `.env` | Requires internet (blocked by GFW locally) |
| **Google Gemini** | Gemini 3, Gemini 2.5 Flash, Gemini 2.5 Pro, Gemini 2.0 Flash | `GEMINI_API_KEY` in `.env` | Requires internet (blocked by GFW locally) |

All providers stream through a unified `/api/chat` NDJSON endpoint. Frontend uses `provider/model` value format (e.g., `ollama/gemma4:26b`, `openai/gpt-5.4`).

## Features

- **Multi-provider Chat** — Switch between Ollama, OpenAI, Gemini from a single dropdown (grouped optgroups)
- **Compare Mode** — Send same prompt to 2+ models simultaneously, view results with tab switching
- **File Attachments** — Attach images (vision), PDFs, DOCX, TXT to chat messages. Images sent natively to providers; docs have text extracted server-side
- **Image Generation** — Flux Dev via ComfyUI
- **Video Generation** — HunyuanVideo via ComfyUI
- **Text-to-Speech** — Gemini 3.1 Flash TTS with 26 voices, emotional meta-tags, style direction
- **Model Management** — Pull/delete Ollama models, view GPU/VRAM stats, see ComfyUI models
- **Free VRAM** — One-click button to unload ComfyUI models from VRAM for faster LLM inference

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start with --watch (auto-restart on changes)
npm start            # Production start
```

Server runs on port 3200 by default. Set `PORT`, `OLLAMA_URL`, `COMFYUI_URL` env vars to override.

## Environment Variables (.env)

```
OPENAI_API_KEY=sk-proj-...
GEMINI_API_KEY=AIza...
```

Keys stored in `AIPlayground/.env` (gitignored). Template at `.env.example`.

## Directory Structure

```
AIPlayground/
├── server/
│   ├── index.js              # Express backend: proxy, SQLite, REST API, /api/chat, /api/tts
│   ├── file-utils.js         # Attachment preprocessing (PDF/DOCX text extraction)
│   └── providers/
│       ├── ollama.js         # Ollama streaming (with vision/images support)
│       ├── openai.js         # OpenAI streaming (with vision support)
│       └── gemini.js         # Gemini streaming (with inlineData support)
├── public/
│   ├── index.html            # App shell: 5 tabs (Chat, Image, Video, Audio, Models)
│   ├── css/style.css         # Design system (dark theme, KreativeLand tokens)
│   └── js/
│       ├── api.js            # Shared API client (all providers + ComfyUI + local backend)
│       ├── app.js            # Tab navigation, status bar, model selector (grouped)
│       ├── chat.js           # Chat module: streaming, markdown, file attachments, conversations
│       ├── compare.js        # Compare mode: parallel multi-model prompting with tabbed results
│       ├── tts.js            # Text-to-Speech: Gemini TTS with voice/emotion controls
│       ├── image.js          # Flux image generation via ComfyUI
│       ├── video.js          # HunyuanVideo video generation via ComfyUI
│       └── models.js         # GPU status, model list, pull/delete
├── data/
│   ├── playground.db         # SQLite database (auto-created)
│   └── outputs/              # Downloaded generated media
├── .env                      # API keys (gitignored)
├── .env.example              # Template
├── package.json
└── .gitignore
```

## Key Design Decisions

1. **No build step** — vanilla JS with IIFE modules, CDN for marked.js and highlight.js
2. **Node.js built-in SQLite** — `node:sqlite` (requires Node >= 22.5), no native compilation needed
3. **Express 5** — uses path-to-regexp v8 (`*path` wildcards return arrays, join with `/`)
4. **Proxy pattern** — browser hits `/ollama/*` and `/comfyui/*`, Express forwards to the GPU machine. Solves CORS without touching upstream services
5. **Unified NDJSON streaming** — All providers normalized to `{type:"chunk",content}` / `{type:"done",content,meta}` format via async generators
6. **dotenv with explicit path** — `.env` loaded relative to `__dirname/../.env` so it works regardless of cwd

## ComfyUI Workflow Models

**ComfyUI install path on office PC:** `C:\Users\Damas\Documents\ComfyUI\`
**Models base path:** `C:\Users\Damas\Documents\ComfyUI\models\`

Image generation (Flux) expects these files in ComfyUI:
- `unet/flux1-dev.safetensors` (confirmed present)
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
**Status:** v1.1 — multi-provider chat, compare mode, file attachments, TTS (2026-04-20)

### Completed (2026-04-20)
- Multi-provider chat: Ollama (local), OpenAI (GPT-5.4 series), Google Gemini
- Unified `/api/chat` streaming endpoint with async generator pattern
- Model selector with grouped optgroups by provider
- Compare mode: parallel multi-model prompting with tabbed result switching
- File attachments: images (vision), PDFs, DOCX, TXT — text extracted server-side
- Text-to-Speech tab: Gemini 3.1 Flash TTS, 26 voices, emotional meta-tags
- Free VRAM button for ComfyUI model unloading
- Provider toggles for Image/Video tabs (future provider support)

### Pending
- Deployment to ai.kreativeland.com (Azure VM, DNS A record needed)
- Motif-Video-2B integration (waiting for full weights/code release)
- Nvidia Lyra 2.0 / HY-World 2.0 exploration (needs custom inference pipeline)
