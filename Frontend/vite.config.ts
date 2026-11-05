import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The pathway compiler lives in ../shared (also used by the backend).
  // Fixed port: the API and S3 CORS allow http://localhost:5173 only, so never drift to 5174.
  server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
  preview: { port: 5173, strictPort: true },
})
