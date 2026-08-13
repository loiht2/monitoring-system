import './globals.css';

export const metadata = { title: 'GPU Monitoring' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Runtime config, written by docker-entrypoint.sh at container start. */}
        <script src="/env.js" />
      </head>
      <body>{children}</body>
    </html>
  );
}
