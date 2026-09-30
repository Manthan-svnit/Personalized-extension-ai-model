#!/usr/bin/env node
/**
 * Keyboard Warriors - Automated ONNX Model Downloader
 * Downloads quantized ONNX models for local on-device vision inference.
 *
 * Usage: node scripts/download-models.mjs
 */

import { createWriteStream, mkdirSync, existsSync, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { get } from 'https';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const MODELS_DIR = resolve(ROOT_DIR, 'public', 'models');

// Ensure models directory exists
if (!existsSync(MODELS_DIR)) {
  mkdirSync(MODELS_DIR, { recursive: true });
  console.log(`[Keyboard Warriors] Created directory: ${MODELS_DIR}`);
}

/** Model definitions */
const MODELS = [
  {
    name: 'blazeface.onnx',
    // The actual file in garavv/blazeface-onnx is named 'blaze.onnx' on HF; we rename on save
    url: 'https://huggingface.co/garavv/blazeface-onnx/resolve/main/blaze.onnx',
    description: 'BlazeFace — Lightweight face detector (128x128 input)',
    minSizeBytes: 100_000  // ~300 KB expected
  },
  {
    name: 'yolov8n.onnx',
    // Public unauthenticated HF repository with standard YOLOv8n ONNX model
    url: 'https://huggingface.co/kshitijjjjjjjjjjjjjjjj/yolov8n-coco-onnx/resolve/main/yolov8n.onnx',
    description: 'YOLOv8n — Nano general object detector (640x640 input)',
    minSizeBytes: 1_000_000  // ~12 MB expected
  }
];

/**
 * Follows HTTP 3xx redirects and returns final response
 */
function fetchWithRedirects(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects === 0) {
      reject(new Error(`Too many redirects for: ${url}`));
      return;
    }

    get(url, {
      headers: {
        'User-Agent': 'keyboard-warriors-model-downloader/1.0'
      }
    }, (res) => {
      const { statusCode, headers } = res;

      // Follow redirects (301, 302, 303, 307, 308)
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume(); // Drain the socket
        console.log(`  ↳ Redirect (${statusCode}) → ${headers.location}`);
        fetchWithRedirects(headers.location, maxRedirects - 1).then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode} for: ${url}`));
        return;
      }

      resolve(res);
    }).on('error', reject);
  });
}

/**
 * Download a single model file, skipping if already present and valid
 */
async function downloadModel(model) {
  const destPath = resolve(MODELS_DIR, model.name);

  // Skip if already downloaded and valid size
  if (existsSync(destPath)) {
    const stat = statSync(destPath);
    if (stat.size >= model.minSizeBytes) {
      console.log(`✅ [SKIP] ${model.name} already exists (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
      return;
    }
    console.log(`⚠️  ${model.name} exists but appears too small (${stat.size} bytes). Re-downloading...`);
  }

  console.log(`\n⬇️  Downloading: ${model.name}`);
  console.log(`   Source:  ${model.url}`);
  console.log(`   Dest:    ${destPath}`);
  console.log(`   ${model.description}`);

  try {
    const response = await fetchWithRedirects(model.url);
    const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
    let downloadedBytes = 0;
    let lastLoggedPercent = -1;

    response.on('data', (chunk) => {
      downloadedBytes += chunk.length;
      if (totalBytes > 0) {
        const percent = Math.floor((downloadedBytes / totalBytes) * 100);
        if (percent !== lastLoggedPercent && percent % 10 === 0) {
          process.stdout.write(`   Progress: ${percent}% (${(downloadedBytes / 1024 / 1024).toFixed(2)} MB / ${(totalBytes / 1024 / 1024).toFixed(2)} MB)\r`);
          lastLoggedPercent = percent;
        }
      }
    });

    const dest = createWriteStream(destPath);
    await pipeline(response, dest);

    const finalStat = statSync(destPath);
    console.log(`\n✅ ${model.name} saved — ${(finalStat.size / 1024 / 1024).toFixed(2)} MB`);

    if (finalStat.size < model.minSizeBytes) {
      console.error(`❌ ERROR: ${model.name} is too small (${finalStat.size} bytes). Download may be incomplete.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n❌ FAILED to download ${model.name}:`, err.message);
    console.error(`   Please download manually from: ${model.url}`);
    console.error(`   And place in: ${MODELS_DIR}`);
    process.exitCode = 1;
  }
}

/**
 * Main entrypoint
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║   Keyboard Warriors — ONNX Model Downloader              ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`Models directory: ${MODELS_DIR}\n`);

  for (const model of MODELS) {
    await downloadModel(model);
  }

  console.log('\n══════════════════════════════════════════════════════════');
  if (process.exitCode === 1) {
    console.log('⚠️  Some models failed to download. Build will continue,');
    console.log('    but vision inference will fall back to mock mode.');
  } else {
    console.log('✅  All models downloaded successfully.');
    console.log('    Run `npm run build` to bundle the extension.');
  }
  console.log('══════════════════════════════════════════════════════════\n');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
