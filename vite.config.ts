import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import fs from 'fs';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'chrome-extension-manifest-builder',
      // Copy and adapt manifest.json and static styles into dist
      closeBundle() {
        const distDir = resolve(__dirname, 'dist');
        if (!fs.existsSync(distDir)) {
          fs.mkdirSync(distDir, { recursive: true });
        }

        // 1. Process manifest.json
        const rootManifestPath = resolve(__dirname, 'manifest.json');
        if (fs.existsSync(rootManifestPath)) {
          const rawManifest = fs.readFileSync(rootManifestPath, 'utf-8');
          const manifestObj = JSON.parse(rawManifest);

          // Update entry point file extensions from .ts to .js for dist
          if (manifestObj.background?.service_worker) {
            manifestObj.background.service_worker = manifestObj.background.service_worker.replace(/\.ts$/, '.js');
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

        // 2. Ensure content styles are placed at dist/src/content/styles.css
        const contentStylesSrc = resolve(__dirname, 'src/content/styles.css');
        const contentStylesDistDir = resolve(distDir, 'src/content');
        if (fs.existsSync(contentStylesSrc)) {
          if (!fs.existsSync(contentStylesDistDir)) {
            fs.mkdirSync(contentStylesDistDir, { recursive: true });
          }
          fs.copyFileSync(contentStylesSrc, resolve(contentStylesDistDir, 'styles.css'));
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
          if (chunkInfo.name === 'background') {
            return 'src/background/index.js';
          }
          if (chunkInfo.name === 'content') {
            return 'src/content/index.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith('.css') && assetInfo.name.includes('content')) {
            return 'src/content/styles.css';
          }
          return 'assets/[name]-[hash].[ext]';
        }
      }
    }
  }
});
