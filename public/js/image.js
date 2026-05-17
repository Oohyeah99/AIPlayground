/**
 * image.js — Image generation tab: ComfyUI workflows + Imagen API, gallery, lightbox
 */
const ImageGen = (() => {
  const $provider = document.getElementById('img-provider');
  const $prompt = document.getElementById('img-prompt');
  const $size = document.getElementById('img-size');
  const $steps = document.getElementById('img-steps');
  const $cfg = document.getElementById('img-cfg');
  const $seed = document.getElementById('img-seed');
  const $aspectRatio = document.getElementById('img-aspect-ratio');
  const $btnGen = document.getElementById('btn-gen-image');
  const $progress = document.getElementById('img-progress');
  const $gallery = document.getElementById('img-gallery');

  // Control groups that are ComfyUI-only
  const $comfyuiControls = document.getElementById('comfyui-img-controls');
  const $apiControls = document.getElementById('api-img-controls');

  // Provider registry
  const providers = {
    'flux-dev':     { type: 'comfyui', name: 'Flux Dev (ComfyUI)',           buildWorkflow: fluxWorkflow,        defaults: { steps: 20, cfg: 3.5 } },
    'dalle3':       { type: 'api', name: 'OpenAI GPT Image',          apiModel: 'gpt-image-1' },
    'imagen-fast':  { type: 'api', name: 'Google Imagen 4.0 Fast',  apiModel: 'imagen-4.0-fast-generate-001' },
    'imagen':       { type: 'api', name: 'Google Imagen 4.0',       apiModel: 'imagen-4.0-generate-001' },
    'imagen-ultra': { type: 'api', name: 'Google Imagen 4.0 Ultra', apiModel: 'imagen-4.0-ultra-generate-001' },
  };

  let generating = false;

  // --- ComfyUI Workflows ---

  function fluxWorkflow(prompt, width, height, steps, cfg, seed) {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors", weight_dtype: "fp8_e4m3fn" } },
      "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl_fp16.safetensors", clip_name2: "clip_l.safetensors", type: "flux" } },
      "3": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: prompt } },
      "4": { class_type: "CLIPTextEncode", inputs: { clip: ["2", 0], text: "" } },
      "5": { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
      "6": { class_type: "KSampler", inputs: { model: ["1", 0], seed, steps, cfg, sampler_name: "euler", scheduler: "simple", positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], denoise: 1.0 } },
      "7": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["7", 0] } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "playground" } },
    };
  }

  // --- Generation ---

  async function generateComfyUI(provider, prompt) {
    const [w, h] = $size.value.split('x').map(Number);
    const steps = parseInt($steps.value) || 20;
    const cfg = parseFloat($cfg.value) || 3.5;
    const seed = $seed.value ? parseInt($seed.value) : Math.floor(Math.random() * 2 ** 32);

    const workflow = provider.buildWorkflow(prompt, w, h, steps, cfg, seed);
    const promptId = await API.comfyuiSubmit(workflow);
    $progress.querySelector('.progress-text').textContent = 'Generating...';

    let result = null;
    while (!result) {
      await new Promise(r => setTimeout(r, 2000));
      const entry = await API.comfyuiHistory(promptId);
      if (entry?.status?.completed) {
        result = entry;
      } else if (entry?.status?.status_str?.toLowerCase().includes('error')) {
        throw new Error('Generation failed: ' + entry.status.status_str);
      }
    }

    const filenames = [];
    for (const [, nodeOut] of Object.entries(result.outputs || {})) {
      if (nodeOut.images) nodeOut.images.forEach(img => filenames.push(img.filename));
    }
    if (!filenames.length) throw new Error('No output files');

    const imgUrl = await API.comfyuiDownloadUrl(filenames[0]);
    return { imgUrl, filename: filenames[0], width: w, height: h, steps, cfg, seed, meta: `${w}x${h} | ${steps} steps | seed ${seed}` };
  }

  async function generateImagen(provider, prompt) {
    const aspectRatio = $aspectRatio.value;
    $progress.querySelector('.progress-text').textContent = 'Generating with Imagen...';

    const data = await API.imagen(prompt, provider.apiModel, aspectRatio);
    if (!data.images?.length) throw new Error('No images returned');

    const img = data.images[0];
    let imgUrl;
    let filename;

    if (data.filename) {
      // Server saved the file (Azure VM path)
      imgUrl = `/outputs/${data.filename}`;
      filename = data.filename;
    } else {
      // Vercel returns base64 — upload to Azure VM for persistence
      filename = `imagen-${Date.now()}.${img.mimeType.includes('jpeg') ? 'jpg' : 'png'}`;
      try {
        await API.uploadMedia(filename, img.base64, img.mimeType);
        imgUrl = `/outputs/${filename}`;
      } catch (e) {
        console.warn('[ImageGen] Upload failed, using base64 fallback:', e);
        imgUrl = `data:${img.mimeType};base64,${img.base64}`;
      }
    }

    return { imgUrl, filename, width: null, height: null, meta: `${provider.name} | ${aspectRatio}` };
  }

  async function generateDalle(provider, prompt) {
    const aspectRatio = $aspectRatio.value;
    $progress.querySelector('.progress-text').textContent = 'Generating with OpenAI GPT Image...';

    const data = await API.dalle(prompt, provider.apiModel, aspectRatio);
    if (!data.imageUrl && !data.imageBase64) throw new Error('No image returned');

    let imgUrl;
    let filename;

    if (data.imageBase64) {
      filename = `dalle-${Date.now()}.png`;
      // Upload to Azure VM for persistence
      try {
        await API.uploadMedia(filename, data.imageBase64, 'image/png');
        imgUrl = `/outputs/${filename}`;
      } catch (e) {
        console.warn('[ImageGen] Upload failed, using base64 fallback:', e);
        imgUrl = `data:image/png;base64,${data.imageBase64}`;
      }
    } else {
      imgUrl = data.imageUrl;
      filename = `dalle-${Date.now()}.png`;
    }

    return { imgUrl, filename, width: null, height: null, meta: `${provider.name} | ${aspectRatio}` };
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
    let provider;
    try {
      provider = providers[$provider.value];
      if (!provider) throw new Error('Unknown provider: ' + $provider.value);

      let result;
      if (provider.type === 'comfyui') {
        result = await generateComfyUI(provider, prompt);
      } else if (provider.apiModel?.startsWith('dall-e')) {
        result = await generateDalle(provider, prompt);
      } else {
        result = await generateImagen(provider, prompt);
      }

      const duration = Date.now() - startTime;

      try {
        await API.saveGeneration({
          type: 'image', prompt, width: result.width, height: result.height,
          steps: result.steps || null, cfg: result.cfg || null, seed: result.seed || null,
          provider: $provider.value,
          filename: result.filename, duration_ms: duration, status: 'complete',
        });
      } catch (saveErr) {
        console.warn('[ImageGen] Save generation failed (non-fatal):', saveErr);
      }

      addGalleryItem(result.imgUrl, prompt, `${result.meta} | ${(duration / 1000).toFixed(1)}s`);
    } catch (err) {
      console.error('[ImageGen] Error:', err);
      const isApiProvider = provider?.type === 'api';
      let errorMsg = err.message;
      if (isApiProvider && errorMsg.includes('location')) {
        errorMsg = 'Imagen is not available in your region (geographic restriction by Google). Use Flux Dev instead.';
      }
      $progress.querySelector('.progress-fill').classList.remove('indeterminate');
      $progress.querySelector('.progress-fill').style.width = '0%';
      $progress.querySelector('.progress-text').textContent = `Error: ${errorMsg}`;
      $progress.querySelector('.progress-text').style.color = '#ef4444';
      // Keep error visible for 10 seconds so user can read it
      await new Promise(r => setTimeout(r, 10000));
      $progress.querySelector('.progress-text').style.color = '';
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
    el.innerHTML = `
      <img src="${url}" alt="${prompt.slice(0, 100)}" loading="lazy">
      <div class="gallery-item-info">
        <div class="gallery-item-prompt" title="${prompt.replace(/"/g, '&quot;')}">${prompt.slice(0, 80)}</div>
        <div class="gallery-item-meta">${meta}</div>
      </div>
    `;
    el.addEventListener('click', () => {
      Lightbox.open({
        mediaHtml: `<img src="${url}" alt="" style="max-width:90vw;max-height:65vh;">`,
        prompt,
        meta,
        onUsePrompt: (p) => { $prompt.value = p; $prompt.focus(); },
      });
    });
    $gallery.prepend(el);
  }

  async function loadHistory() {
    try {
      const items = await API.getGenerations('image', 50);
      if (items.length) {
        $gallery.querySelector('.gallery-empty')?.remove();
        for (const item of items.reverse()) {
          if (item.filename && item.status === 'complete') {
            // Local API files (imagen-, dalle-) are in /outputs/, ComfyUI files via proxy
            const isLocal = item.filename.startsWith('imagen-') || item.filename.startsWith('dalle-');
            const url = isLocal ? `/outputs/${item.filename}` : await API.comfyuiDownloadUrl(item.filename);
            const meta = item.width ? `${item.width}x${item.height} | ${item.steps} steps | seed ${item.seed}` : (item.provider || 'Imagen');
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
      if (p.defaults) {
        $steps.value = p.defaults.steps;
        $cfg.value = p.defaults.cfg;
      }
    }
  }

  function init() {
    $btnGen.addEventListener('click', generate);
    $provider.addEventListener('change', onProviderChange);
    onProviderChange(); // Set initial state
    loadHistory();

    // Random prompt button
    const $btnRandom = document.getElementById('btn-random-img-prompt');
    if ($btnRandom) {
      $btnRandom.addEventListener('click', async () => {
        $btnRandom.disabled = true;
        $btnRandom.textContent = '...';
        try {
          const prompt = await API.randomPrompt('image');
          if (prompt) $prompt.value = prompt;
        } catch (e) {
          console.warn('[ImageGen] Random prompt failed:', e);
        } finally {
          $btnRandom.disabled = false;
          $btnRandom.textContent = '🎲';
        }
      });
    }
  }

  return { init };
})();
