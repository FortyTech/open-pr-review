export const metadata = { title: 'open-pr-review' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'ui-monospace, monospace', padding: '3rem', lineHeight: 1.6 }}>
        {children}
      </body>
    </html>
  );
}
