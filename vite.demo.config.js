import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Builds only the public web demo (demo.html), separate from the Electron app build.
// The output is renamed from demo.html to index.html by the build:demo npm script so it
// can be served directly from GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist-demo',
    rollupOptions: {
      input: 'demo.html',
    },
  },
})
