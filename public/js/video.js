/**
 * video.js — Video generation tab: HunyuanVideo workflow, gallery
 */
const VideoGen = (() => {
  const $prompt = document.getElementById('vid-prompt');
  const $size = document.getElementById('vid-size');
  const $frames = document.getElementById('vid-frames');
  const $steps = document.getElementById('vid-steps');
  const $seed = document.getElementById('vid-seed');
  const $btnGen = document.getElementById('btn-gen-video');
  const $progress = document.getElementById('vid-progress');
  const $gallery = document.getElementById('vid-gallery');

  let generating = false;

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

  async function generate() {
    if (generating) return;
    const prompt = $prompt.value.trim();
    if (!prompt) return;

    const [w, h] = $size.value.split('x').map(Number);
    const frames = parseInt($frames.value) || 37;
    const steps = parseInt($steps.value) || 20;
    const seed = $seed.value ? parseInt($seed.value) : Math.floor(Math.random() * 2 ** 32);

    generating = true;
    $btnGen.disabled = true;
    $progress.classList.remove('hidden');
    $progress.querySelector('.progress-fill').classList.add('indeterminate');
    $progress.querySelector('.progress-text').textContent = 'Submitting...';

    const startTime = Date.now();
    try {
      const workflow = hunyuanWorkflow(prompt, w, h, frames, steps, seed);
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
      const duration = Date.now() - startTime;

      await API.saveGeneration({
        type: 'video', prompt, width: w, height: h, steps, cfg: 6.0, seed,
        filename: filenames[0], duration_ms: duration, status: 'complete',
      });

      addGalleryItem(vidUrl, prompt, `${w}x${h} | ${frames} frames | ${steps} steps | ${(duration / 1000).toFixed(1)}s`);
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
      <img src="${url}" alt="${prompt.slice(0, 100)}" style="image-rendering: auto;">
      <div class="gallery-item-info">
        <div class="gallery-item-prompt" title="${prompt.replace(/"/g, '&quot;')}">${prompt.slice(0, 80)}</div>
        <div class="gallery-item-meta">${meta}</div>
      </div>
    `;
    $gallery.prepend(el);
  }

  async function loadHistory() {
    try {
      const items = await API.getGenerations('video', 50);
      if (items.length) {
        $gallery.querySelector('.gallery-empty')?.remove();
        for (const item of items.reverse()) {
          if (item.filename && item.status === 'complete') {
            const url = await API.comfyuiDownloadUrl(item.filename);
            addGalleryItem(url, item.prompt, `${item.width}x${item.height} | ${item.steps} steps`);
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
