import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <title>QNet - Quantum Network</title>
        <meta name="description" content="Experimental AI-developed blockchain built by one person. No funding. No team. No corporate backing. Just pure determination to prove that a single developer can build a quantum-resistant blockchain that challenges the entire industry." />
      </head>
      <body suppressHydrationWarning className="font-sans antialiased quantum-bg">
        <div className="app-wrapper">
          {children}
        </div>
      </body>
    </html>
  );
} 