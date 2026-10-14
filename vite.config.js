import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Destellos de Oro POS',
        short_name: 'DestellosPOS',
        description: 'Punto de Venta e Inventario Destellos de Oro',
        theme_color: '#FDF3F6',
        background_color: '#FDF3F6',
        display: 'standalone',
        icons: [
          {
            src: '/favicon.svg',
            sizes: '192x192',
            type: 'image/svg+xml'
          }
        ]
      }
    })
  ],
})