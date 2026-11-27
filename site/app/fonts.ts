import localFont from 'next/font/local';

/**
 * Pixelify Sans, the product's own heading font, served from the site itself (site/fonts/pixelify-sans/, with its
 * SIL Open Font License). Body text uses the system's own sans-serif, as the product's web app does.
 */
export const pixelify = localFont({
  src: '../fonts/pixelify-sans/PixelifySans.ttf',
  weight: '400 700',
  display: 'swap',
  variable: '--font-pixel',
  adjustFontFallback: false,
  fallback: ['ui-monospace', 'Cascadia Code', 'Menlo', 'Consolas', 'monospace'],
});
