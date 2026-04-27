import { defineConfig } from 'vite';
import { avatarkitVitePlugin } from '@spatialwalk/avatarkit/vite';

export default defineConfig({
  envDir: '../',
  plugins: [avatarkitVitePlugin()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
