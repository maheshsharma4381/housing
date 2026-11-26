import type { MetadataRoute } from 'next';

// The installable app (spec: no native app — this PWA is the mobile app). Android needs 192 and 512 PNG icons
// and a maskable one; the iPhone Home Screen uses apple-touch-icon (layout.tsx).
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Sahvaas - Housing Society Management',
    short_name: 'Sahvaas',
    description: 'Maintenance bills, payments, notices and complaints for your housing society',
    // the installed app opens on login, which sends a signed-in person straight to their screen
    start_url: '/login',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f7f9',
    theme_color: '#2563eb',
    categories: ['finance', 'productivity'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
  };
}
