import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'

export default defineConfig({
  // Le plugin Cloudflare exécute le Worker (worker/src/index.ts) dans le même
  // serveur que Vite : le front appelle /api/* sans proxy ni second processus,
  // et `vite build` produit le front statique et le Worker ensemble.
  plugins: [react(), tailwindcss(), cloudflare()],
})
