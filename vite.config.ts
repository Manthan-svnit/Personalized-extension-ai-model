import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';

/**
 * Recursively copy a directory
 */
function copyDirSync(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'chrome-extension-builder',
      closeBundle() {
        const distDir = resolve(__dirname, 'dist');
        if (!fs.existsSync(distDir)) {
          fs.mkdirSync(distDir, { recursive: true });
        }

        // 1. Process and emit manifest.json (rewrite .ts → .js for entry points)
        const rootManifestPath = resolve(__dirname, 'manifest.json');
        if (fs.existsSync(rootManifestPath)) {
          const rawManifest = fs.readFileSync(rootManifestPath, 'utf-8');
          const manifestObj = JSON.parse(rawManifest);

          if (manifestObj.background?.service_worker) {
            manifestObj.background.service_worker =
              manifestObj.background.service_worker.replace(/\.ts$/, '.js');
          }

          if (Array.isArray(manifestObj.content_scripts)) {
            manifestObj.content_scripts.forEach((cs: any) => {
              if (Array.isArray(cs.js)) {
                cs.js = cs.js.map((script: string) => script.replace(/\.ts$/, '.js'));
              }
            });
          }

          fs.writeFileSync(
            resolve(distDir, 'manifest.json'),
            JSON.stringify(manifestObj, null, 2),
            'utf-8'
          );
        }

        // 2. Copy content script styles
        const contentStylesSrc = resolve(__dirname, 'src/content/styles.css');
        const contentStylesDistDir = resolve(distDir, 'src/content');
        if (fs.existsSync(contentStylesSrc)) {
          if (!fs.existsSync(contentStylesDistDir)) {
            fs.mkdirSync(contentStylesDistDir, { recursive: true });
          }
          fs.copyFileSync(contentStylesSrc, resolve(contentStylesDistDir, 'styles.css'));
        }

        // 3. Copy ONNX WASM binaries from onnxruntime-web into dist/assets/
        //    ORT Web's WASM files need to be accessible at runtime from the same domain.
        const ortWasmDir = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
        const distAssetsDir = resolve(distDir, 'assets');
        if (!fs.existsSync(distAssetsDir)) {
          fs.mkdirSync(distAssetsDir, { recursive: true });
        }
        const distOffscreenDir = resolve(distDir, 'src/offscreen');
        if (!fs.existsSync(distOffscreenDir)) {
          fs.mkdirSync(distOffscreenDir, { recursive: true });
        }
        if (fs.existsSync(ortWasmDir)) {
          const wasmFiles = fs.readdirSync(ortWasmDir).filter(
            f => f.endsWith('.wasm') || f.endsWith('.mjs') || f.endsWith('.js')
          );
          for (const wasmFile of wasmFiles) {
            fs.copyFileSync(
              resolve(ortWasmDir, wasmFile),
              resolve(distAssetsDir, wasmFile)
            );
            fs.copyFileSync(
              resolve(ortWasmDir, wasmFile),
              resolve(distOffscreenDir, wasmFile)
            );
          }
          console.log(`[chrome-extension-builder] Copied ${wasmFiles.length} ORT WASM file(s) to dist/assets/ and dist/src/offscreen/`);
        } else {
          console.warn('[chrome-extension-builder] onnxruntime-web dist not found. Run: npm install onnxruntime-web');
        }

        // 4. Copy public/models/ (ONNX model files) → dist/models/
        const publicModelsDir = resolve(__dirname, 'public/models');
        const distModelsDir = resolve(distDir, 'models');
        if (fs.existsSync(publicModelsDir)) {
          copyDirSync(publicModelsDir, distModelsDir);
          const modelFiles = fs.readdirSync(publicModelsDir);
          console.log(`[chrome-extension-builder] Copied ${modelFiles.length} model file(s) to dist/models/`);
        } else {
          console.warn('[chrome-extension-builder] public/models/ not found. Run: npm run download-models');
          // Create empty directory so manifest references don't fail
          fs.mkdirSync(distModelsDir, { recursive: true });
        }
      }
    }
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'src/sidepanel/sidepanel.html'),
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts')
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') return 'src/background/index.js';
          if (chunkInfo.name === 'content') return 'src/content/index.js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css') && assetInfo.name.includes('content')) {
            return 'src/content/styles.css';
          }
          return 'assets/[name]-[hash].[ext]';
        }
      },
      // Prevent rollup from trying to bundle WASM files (they are native binary)
      external: (id) => id.endsWith('.wasm')
    }
  },
  optimizeDeps: {
    exclude: ['onnxruntime-web']
  }
});
