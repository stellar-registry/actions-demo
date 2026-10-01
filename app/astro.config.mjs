import { defineConfig } from 'astro/config';

// Served from GitHub Pages at https://stellar-registry.github.io/actions-demo/.
export default defineConfig({
  site: 'https://stellar-registry.github.io',
  base: '/actions-demo',
  // One page; stellar-sdk is most of the ~1.1 MB bundle.
  vite: { build: { chunkSizeWarningLimit: 1500 } },
});
