import type { ReactNode } from 'react';

export const metadata = {
  title: 'Superconnector',
  description: 'Multi-account Google connector for Claude (MCP)',
};

export const viewport = {
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#121316' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: 'light dark' }}>
      <body style={{ margin: 0, background: 'Canvas', color: 'CanvasText' }}>{children}</body>
    </html>
  );
}
