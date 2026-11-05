import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AuthProvider } from '../context/AuthContext';
import { RouterProvider } from '../router/RouterContext';
import { OfflineIndicator } from '../components/OfflineIndicator';
import { NamePrompt } from '../components/NamePrompt';
import { AddMobilePrompt } from '../components/AddMobilePrompt';
import { ServiceWorkerRegister } from '../components/ServiceWorkerRegister';

export const viewport: Viewport = {
  themeColor: '#0284c7',
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  title: 'Sahvaas - Housing Society Management',
  description: 'Multi-tenant housing society management and operations platform with automated backend financials, granular professional access, and mobile-first PWA.',
  openGraph: {
    title: 'Sahvaas - Housing Society Management',
    description: 'Multi-tenant housing society management and operations platform with automated backend financials, granular professional access, and mobile-first PWA.',
    type: 'website',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Sahvaas',
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }, { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' }],
    // the iPhone Home Screen ignores SVG
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="bg-slate-950 text-slate-100 antialiased selection:bg-sky-500 selection:text-white min-h-screen flex flex-col font-sans">
        <RouterProvider>
          <AuthProvider>
            <div className="flex-1 flex flex-col">
              {children}
            </div>
            <OfflineIndicator />
            <NamePrompt />
            <AddMobilePrompt />
            <ServiceWorkerRegister />
          </AuthProvider>
        </RouterProvider>
      </body>
    </html>
  );
}
