import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { asset } from '../components/site/base';
import { pixelify } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  icons: {
    icon: [{ url: asset('favicon.ico'), sizes: 'any' }, { url: asset('brand/logo-32.png'), type: 'image/png', sizes: '32x32' }],
    apple: [{ url: asset('apple-touch-icon.png'), sizes: '180x180' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#0c1328',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={pixelify.variable}>
      <body>{children}</body>
    </html>
  );
}
