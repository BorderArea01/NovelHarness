import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:3210' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        'state-patch': fileURLToPath(new URL('./src/state-patch.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === 'state-patch' ? 'state-patch.js' : 'assets/[name]-[hash].js',
      },
    },
  },
});
