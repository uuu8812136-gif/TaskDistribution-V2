import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: "0.0.0.0",
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:8099',
        changeOrigin: true
      }
    },
    allowedHosts: [
       "localhost",
       "127.0.0.1",
       "43.139.209.249",
       "renwufenfa.chirlynai.ltd",
       "www.horselink.cn"
    ]
  }
})

