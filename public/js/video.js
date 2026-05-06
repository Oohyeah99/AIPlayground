/**
 * video.js — Video generation tab: ComfyUI workflows + Veo API, gallery
 */
const VideoGen = (() => {
  const $provider = document.getElementById('vid-provider');
  const $prompt = document.getElementById('vid-prompt');
  const $size = document.getElementById('vid-size');
  const $frames = document.getElementById('vid-frames');
  const $steps = document.getElementById('vid-steps');
  const $seed = document.getElementById('vid-seed');
  const $aspectRatio = document.getElementById('vid-aspect-ratio');
  const $duration = document.getElementById('vid-duration');
  const $btnGen = document.getElementById('btn-gen-video');
  const $progress = document.getElementById('vid-progress');
  const $gallery = document.getElementById('vid-gallery');

  // Control groups for show/hide
  const $comfyuiControls = document.getElementById('comfyui-vid-controls');
  const $apiControls = document.getElementById('api-vid-controls');

  // Provider registry
  const providers = {
    'hunyuan-video': { type: 'comfyui', name: 'HunyuanVideo', buildWorkflow: hunyuanWorkflow },
    'veo-lite':      { type: 'api', name: 'Veo 3.1 Lite', apiModel: 'veo-3.1-lite-generate-preview' },
    'veo-fast':      { type: 'api', name: 'Veo 3.1 Fast', apiModel: 'veo-3.1-fast-generate-preview' },
    'veo':           { type: 'api', name: 'Veo 3.1',      apiModel: 'veo-3.1-generate-preview' },
  };

  let generating = false;

  // --- ComfyUI Workflow ---

  function hunyuanWorkflow(prompt, width, height, frames, steps, seed) {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "hunyuan_video_t2v_720p_bf16.safetensors", weight_dtype: "fp8_e4m3fn" } },
      "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: "llava_llama3_fp8_scaled.safetensors", clip_name2: "clip_l.safetensors", type: "hunyuan_video" } },
      "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
      "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "" } },
      "5": { class_type: "EmptyHunyuanLatentVideo", inputs: { width, height, length: frames, batch_size: 1 } },
      "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed, steps, cfg: 6.0, sampler_name: "euler", scheduler: "simple", positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], denoise: 1.0 } },
      "7": { class_type: "VAELoader", inputs: { vae_name: "hunyuan_video_vae_bf16.safetensors" } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["7", 0] } },
      "9": { class_type: "SaveAnimatedWEBP", inputs: { images: ["8", 0], filename_prefix: "playground_vid", fps: 8, lossless: false, quality: 80, method: "default" } },
    };
  }

  // --- Generation ---

  async function generateComfyUI(provider, prompt) {
    const [w, h] = $size.value.split('x').map(Number);
    const frames = parseInt($frames.value) || 37;
    const steps = parseInt($steps.value) || 20;
    const seed = $seed.value ? parseInt($seed.value) : Math.floor(Math.random() * 2 ** 32);

    const workflow = provider.buildWorkflow(prompt, w, h, frames, steps, seed);
    const promptId = await API.comfyuiSubmit(workflow);
    $progress.querySelector('.progress-text').textContent = 'Generating (this may take several minutes)...';

    let result = null;
    while (!result) {
      await new Promise(r => setTimeout(r, 3000));
      const entry = await API.comfyuiHistory(promptId);
      if (entry?.status?.completed) {
        result = entry;
      } else if (entry?.status?.status_str?.toLowerCase().includes('error')) {
        throw new Error('Generation failed: ' + entry.status.status_str);
      }
    }

    const filenames = [];
    for (const [, nodeOut] of Object.entries(result.outputs || {})) {
      if (nodeOut.gifs) nodeOut.gifs.forEach(g => filenames.push(g.filename));
      if (nodeOut.images) nodeOut.images.forEach(img => filenames.push(img.filename));
    }
    if (!filenames.length) throw new Error('No output files');

    const vidUrl = await API.comfyuiDownloadUrl(filenames[0]);
    return { vidUrl, filename: filenames[0], width: w, height: h, steps, cfg: 6.0, seed, meta: `${w}x${h} | ${frames} frames | ${steps} steps | seed ${seed}` };
  }

  async function generateVeo(provider, prompt) {
    const aspectRatio = $aspectRatio.value;
    const durationSeconds = parseInt($duration.value) || 8;
    $progress.querySelector('.progress-text').textContent = 'Submitting to Veo...';

    const { operation, model } = await API.veoSubmit(prompt, provider.apiModel, aspectRatio, durationSeconds);
    $progress.querySelector('.progress-text').textContent = 'Generating video (polling for completion)...';

    // Poll until done (Veo is async)
    let pollCount = 0;
    while (true) {
      await new Promise(r => setTimeout(r, 5000));
      pollCount++;
      const status = await API.veoPoll(operation);
      if (status.done) {
        const vidUrl = `/outputs/${status.filename}`;
        return { vidUrl, filename: status.filename, width: null, height: null, meta: `${provider.name} | ${aspectRatio} | ${durationSeconds}s` };
      }
      if (status.error) {
        throw new Error(`Veo error: ${status.error}`);
      }
      $progress.querySelector('.progress-text').textContent = `Generating video (poll #${pollCount})...`;
    }
  }

  async function generate() {
    if (generating) return;
    const prompt = $prompt.value.trim();
    if (!prompt) return;

    generating = true;
    $btnGen.disabled = true;
    $progress.classList.remove('hidden');
    $progress.querySelector('.progress-fill').classList.add('indeterminate');
    $progress.querySelector('.progress-text').textContent = 'Submitting...';

    const startTime = Date.now();
    try {
      const provider = providers[$provider.value];
      if (!provider) throw new Error('Unknown provider: ' + $provider.value);

      let result;
      if (provider.type === 'api') {
        result = await generateVeo(provider, prompt);
      } else {
        result = await generateComfyUI(provider, prompt);
      }

      const duration = Date.now() - startTime;

      await API.saveGeneration({
        type: 'video', prompt, width: result.width, height: result.height,
        steps: result.steps || null, cfg: result.cfg || null, seed: result.seed || null,
        provider: $provider.value,
        filename: result.filename, duration_ms: duration, status: 'complete',
      });

      addGalleryItem(result.vidUrl, prompt, `${result.meta} | ${(duration / 1000).toFixed(1)}s`);
    } catch (err) {
      $progress.querySelector('.progress-text').textContent = `Error: ${err.message}`;
      await new Promise(r => setTimeout(r, 3000));
    } finally {
      generating = false;
      $btnGen.disabled = false;
      $progress.classList.add('hidden');
      $progress.querySelector('.progress-fill').classList.remove('indeterminate');
    }
  }

  // --- Gallery ---

  function addGalleryItem(url, prompt, meta) {
    const empty = $gallery.querySelector('.gallery-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'gallery-item';

    // Veo outputs are mp4, ComfyUI outputs are webp
    const isVideo = url.endsWith('.mp4');
    if (isVideo) {
      el.innerHTML = `
        <video src="${url}" autoplay loop muted playsinline style="width:100%;height:auto;"></video>
        <div class="gallery-item-info">
          <div class="gallery-item-prompt" title="${prompt.replace(/"/g, '&quot;')}">${prompt.slice(0, 80)}</div>
          <div class="gallery-item-meta">${meta}</div>
        </div>
      `;
    } else {
      el.innerHTML = `
        <img src="${url}" alt="${prompt.slice(0, 100)}" style="image-rendering: auto;">
        <div class="gallery-item-info">
          <div class="gallery-item-prompt" title="${prompt.replace(/"/g, '&quot;')}">${prompt.slice(0, 80)}</div>
          <div class="gallery-item-meta">${meta}</div>
        </div>
      `;
    }
    $gallery.prepend(el);

    el.addEventListener('click', () => {
      const mediaHtml = isVideo
        ? `<video src="${url}" autoplay loop controls style="max-width:90vw;max-height:65vh;"></video>`
        : `<img src="${url}" alt="" style="max-width:90vw;max-height:65vh;">`;
      Lightbox.open({
        mediaHtml,
        prompt,
        meta,
        onUsePrompt: (p) => { $prompt.value = p; $prompt.focus(); },
      });
    });
  }

  async function loadHistory() {
    try {
      const items = await API.getGenerations('video', 50);
      if (items.length) {
        $gallery.querySelector('.gallery-empty')?.remove();
        for (const item of items.reverse()) {
          if (item.filename && item.status === 'complete') {
            const isLocal = item.filename.startsWith('veo-');
            const url = isLocal ? `/outputs/${item.filename}` : await API.comfyuiDownloadUrl(item.filename);
            const meta = item.width ? `${item.width}x${item.height} | ${item.steps} steps` : (item.provider || 'Veo');
            addGalleryItem(url, item.prompt, meta);
          }
        }
      }
    } catch {}
  }

  // --- Provider switching ---

  function onProviderChange() {
    const p = providers[$provider.value];
    if (!p) return;

    if (p.type === 'api') {
      $comfyuiControls.classList.add('hidden');
      $apiControls.classList.remove('hidden');
    } else {
      $comfyuiControls.classList.remove('hidden');
      $apiControls.classList.add('hidden');
    }
  }

  function init() {
    $btnGen.addEventListener('click', generate);
    $provider.addEventListener('change', onProviderChange);
    onProviderChange(); // Set initial state
    loadHistory();
  }

  return { init };
})();
