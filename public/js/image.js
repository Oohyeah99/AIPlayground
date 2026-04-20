/**
 * image.js — Image generation tab: Flux workflow, gallery, lightbox
 */
const ImageGen = (() => {
  const $prompt = document.getElementById('img-prompt');
  const $size = document.getElementById('img-size');
  const $steps = document.getElementById('img-steps');
  const $cfg = document.getElementById('img-cfg');
  const $seed = document.getElementById('img-seed');
  const $btnGen = document.getElementById('btn-gen-image');
  const $progress = document.getElementById('img-progress');
  const $gallery = document.getElementById('img-gallery');

  let generating = false;

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

  async function generate() {
    if (generating) return;
    const prompt = $prompt.value.trim();
    if (!prompt) return;

    const [w, h] = $size.value.split('x').map(Number);
    const steps = parseInt($steps.value) || 20;
    const cfg = parseFloat($cfg.value) || 3.5;
    const seed = $seed.value ? parseInt($seed.value) : Math.floor(Math.random() * 2 ** 32);

    generating = true;
    $btnGen.disabled = true;
    $progress.classList.remove('hidden');
    $progress.querySelector('.progress-fill').classList.add('indeterminate');
    $progress.querySelector('.progress-text').textContent = 'Submitting...';

    const startTime = Date.now();
    try {
      const workflow = fluxWorkflow(prompt, w, h, steps, cfg, seed);
      const promptId = await API.comfyuiSubmit(workflow);
      $progress.querySelector('.progress-text').textContent = 'Generating...';

      // Poll until complete
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

      // Extract output
      const filenames = [];
      for (const [, nodeOut] of Object.entries(result.outputs || {})) {
        if (nodeOut.images) nodeOut.images.forEach(img => filenames.push(img.filename));
      }
      if (!filenames.length) throw new Error('No output files');

      const imgUrl = await API.comfyuiDownloadUrl(filenames[0]);
      const duration = Date.now() - startTime;

      // Save to DB
      await API.saveGeneration({
        type: 'image', prompt, width: w, height: h, steps, cfg, seed,
        filename: filenames[0], duration_ms: duration, status: 'complete',
      });

      addGalleryItem(imgUrl, prompt, `${w}x${h} | ${steps} steps | seed ${seed} | ${(duration / 1000).toFixed(1)}s`);
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
      document.getElementById('lightbox-img').src = url;
      document.getElementById('lightbox-info').textContent = prompt;
      document.getElementById('lightbox').classList.remove('hidden');
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
            const url = await API.comfyuiDownloadUrl(item.filename);
            addGalleryItem(url, item.prompt, `${item.width}x${item.height} | ${item.steps} steps | seed ${item.seed}`);
          }
        }
      }
    } catch {}
  }

  function init() {
    $btnGen.addEventListener('click', generate);
    loadHistory();
  }

  return { init };
})();
