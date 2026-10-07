import type { ReactNode } from 'react';

export const metadata = {
  title: 'Superconnector',
  description: 'Multi-account Google connector for Claude (MCP)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
