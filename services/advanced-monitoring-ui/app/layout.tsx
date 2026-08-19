import './globals.css';
import { ThemeProvider, THEME_BOOT_SCRIPT } from '@/components/ThemeProvider';

export const metadata = { title: 'GPU Monitoring' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: the boot script sets data-theme before React hydrates,
    // so the server-rendered <html> (no attribute) legitimately differs from the DOM.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before first paint, so a light-mode reader never sees a dark flash. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
