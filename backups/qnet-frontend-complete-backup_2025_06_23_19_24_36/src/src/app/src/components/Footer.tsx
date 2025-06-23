'use client';

import React, { memo } from 'react';

const FooterComponent = () => {
  return (
    <footer className="qnet-footer compact-footer">
      <div className="footer-content">
        <div className="footer-left">
          The QNet has you, Eon...
        </div>
        <div className="footer-center">
          <div className="social-links badge-row" style={{ gap: '0.75rem', alignItems: 'center' }}>
            <a href="https://github.com/qnet-lab/qnet-project" target="_blank" rel="noopener noreferrer" className="social-link">
              <div className="social-icon" style={{ backgroundColor: '#00ffff', maskImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='currentColor'%3E%3Cpath d='M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z'/%3E%3C/svg%3E")` }}></div>
            </a>
            <a href="https://x.com/AIQnetLab" target="_blank" rel="noopener noreferrer" className="social-link">
              <div className="social-icon" style={{ backgroundColor: '#00ffff', maskImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='currentColor'%3E%3Cpath d='M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z'/%3E%3C/svg%3E")` }}></div>
            </a>
            <a href="https://t.me/AiQnetLab" target="_blank" rel="noopener noreferrer" className="social-link">
              <div className="social-icon" style={{ backgroundColor: '#00ffff', maskImage: `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M21.192 2.012a2.033 2.033 0 0 0-1.806-.415L2.14 8.71c-1.25.485-1.234 1.748.022 2.086l4.69 1.407 10.95-6.57-8.312 7.493-.588 4.542a1.49 1.49 0 0 0 1.42 1.482 1.49 1.49 0 0 0 .61-.13l2.364-1.182 4.418 3.26a1.488 1.488 0 0 0 2.21-.76l3.582-16.73A2.033 2.033 0 0 0 21.192 2.012z"></path></svg>')` }}></div>
            </a>
            <a href="#" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '44px' }}>
              <img src="https://developer.apple.com/assets/elements/badges/download-on-the-app-store.svg" alt="App Store" style={{ height: '44px', width: 'auto' }} />
            </a>
            <a href="#" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" alt="Google Play" style={{ height: '60px' }} />
            </a>
          </div>
        </div>
        <div className="footer-right">
          QNet Lab © 2025
        </div>
      </div>
    </footer>
  );
};

const Footer = memo(FooterComponent);

export default Footer;
