import "./globals.css";
import "./mobile-fixes.css";

import { ThemeProvider } from "@/components/theme/theme-provider";
import { AppProvider } from "@/contexts/AppContext";
import Header from '@/components/Header';
import MatrixRain from '@/components/MatrixRain';
import Footer from '@/components/Footer';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'QNet - Post-Quantum Blockchain',
  description: 'Experimental AI-developed blockchain built by one person. No funding. No team. No corporate backing. Just pure determination to prove that a single developer can build a quantum-resistant blockchain that challenges the entire industry.',
  keywords: 'blockchain, quantum-resistant, post-quantum, cryptocurrency, decentralized, QNet',
  authors: [{ name: 'QNet Developer' }],
  creator: 'QNet Developer',
  publisher: 'QNet',
  robots: 'index, follow',
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon.ico', sizes: '16x16', type: 'image/x-icon' }
    ],
    shortcut: '/favicon.svg',
    apple: '/favicon.svg',
  },
  metadataBase: new URL('https://aiqnet.io'),
  openGraph: {
    title: 'QNet - Post-Quantum Blockchain',
    description: 'The next generation of decentralized technology with quantum resistance.',
    url: 'https://aiqnet.io',
    siteName: 'QNet',
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'QNet - Post-Quantum Blockchain',
    description: 'The next generation of decentralized technology with quantum resistance.',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              // QNet Wallet Detection and Integration
              window.qnetWalletReady = false;
              
              // Check for QNet wallet extension
              function checkQNetWallet() {
                if (window.qnet && window.qnet.isQNet) {
                  window.qnetWalletReady = true;
                  console.log('✅ QNet Wallet detected and ready');
                  
                  // Emit custom event for components
                  window.dispatchEvent(new CustomEvent('qnet:walletReady', {
                    detail: { provider: window.qnet }
                  }));
                  
                  return true;
                }
                return false;
              }
              
              // Initial check
              if (!checkQNetWallet()) {
                // Listen for QNet wallet injection
                window.addEventListener('qnet#initialized', () => {
                  checkQNetWallet();
                });
                
                // Fallback check after delay
                setTimeout(() => {
                  if (!checkQNetWallet()) {
                    console.log('ℹ️ QNet Wallet not detected. Install QNet Extension for full functionality.');
                    
                    // Show install prompt
                    window.dispatchEvent(new CustomEvent('qnet:walletNotFound'));
                  }
                }, 2000);
              }
              
              // Suppress non-QNet wallet errors
              const originalError = console.error;
              console.error = function(...args) {
                const message = args[0];
                if (typeof message === 'string') {
                  if (message.includes('MetaMask') ||
                      message.includes('Phantom') ||
                      message.includes('Solflare') ||
                      message.includes('ChromeTransport') ||
                      message.includes('inpage.js')) {
                    return; // Suppress other wallet errors
                  }
                }
                originalError.apply(console, args);
              };
              
              // Handle favicon errors gracefully
              window.addEventListener('error', function(e) {
                if (e.filename && e.filename.includes('favicon')) {
                  e.preventDefault();
                  return false;
                }
              }, true);
            `,
          }}
        />
      </head>
      <body suppressHydrationWarning className="font-sans antialiased quantum-bg">
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <AppProvider>
            <div className="app-wrapper">
              <MatrixRain />
              <Header />
              <main className="qnet-container">
                {children}
              </main>
              <Footer />
            </div>
          </AppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
} 