import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The pathway compiler lives in ../shared (also used by the backend).
  server: { fs: { allow: ['..'] } },
})
