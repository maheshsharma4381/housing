import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '../context/AuthContext';
import { RouterProvider } from '../router/RouterContext';
import { OfflineIndicator } from '../components/OfflineIndicator';
import { NamePrompt } from '../components/NamePrompt';
import { AddMobilePrompt } from '../components/AddMobilePrompt';
import { ServiceWorkerRegister } from '../components/ServiceWorkerRegister';
import { FeedbackHost } from '../components/ui/feedback';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const viewport: Viewport = {
  themeColor: '#2563eb',
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
    // 'default': a light status bar; the page starts below it (translucent would put the header under the clock and notch)
    statusBarStyle: 'default',
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
    <html lang="en" className={inter.variable}>
      {/* palette-bridge: screens not redesigned yet still use the old dark palette (globals.css) */}
      <body className="palette-bridge bg-canvas text-fg antialiased selection:bg-brand-soft min-h-screen flex flex-col font-sans">
        <RouterProvider>
          <AuthProvider>
            <div className="flex-1 flex flex-col">
              {children}
            </div>
            <OfflineIndicator />
            <NamePrompt />
            <AddMobilePrompt />
            <ServiceWorkerRegister />
            <FeedbackHost />
          </AuthProvider>
        </RouterProvider>
      </body>
    </html>
  );
}
