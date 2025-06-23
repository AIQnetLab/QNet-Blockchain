import { GeistSans } from "geist/font/sans";
import "./globals.css";
import "./mobile-fixes.css";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { AppWrapper } from "@/contexts/AppContext";
import Header from '@/components/Header';
import MatrixRain from '@/components/MatrixRain';
import Footer from '@/components/Footer';

export const metadata = {
  title: 'QNet - Post-Quantum Blockchain',
  description: 'The next generation of decentralized technology.',
};

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
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body suppressHydrationWarning className="font-sans antialiased quantum-bg">
        <div className="app-wrapper">
          <MatrixRain />
          <Header />
          <main className="qnet-container">
            {children}
          </main>
          <Footer />
        </div>
      </body>
    </html>
  );
} 