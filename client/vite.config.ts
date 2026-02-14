import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true
  },
  test: {
    root: path.resolve(__dirname),
    globals: true,
    environment: 'jsdom',
    setupFiles: path.resolve(__dirname, 'vitest.setup.ts'),
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']
  }
});
