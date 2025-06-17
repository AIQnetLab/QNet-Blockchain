'use client';

import React, { useRef, useEffect, useState } from 'react';

const MatrixRain = React.memo(function MatrixRain({ activeSection }: { activeSection: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const [isScrolling, setIsScrolling] = useState(false);

  // Effect to detect scrolling
  useEffect(() => {
    let scrollTimer: NodeJS.Timeout;
    const handleScroll = () => {
      setIsScrolling(true);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => setIsScrolling(false), 150);
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimer);
    };
  }, []);

  // Effect to run the animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let drops: number[] = [];
    const matrix = 'QNET01';
    const fontSize = 16;
    
    const setupCanvas = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx.scale(dpr, dpr);
      const columns = Math.floor(canvas.width / dpr / fontSize);
      drops = Array(columns).fill(1).map(() => Math.random() * canvas.height);
    };

    setupCanvas();

    let lastTime = 0;
    const targetInterval = activeSection === 'home' ? 1000 / 15 : 1000 / 20;

    const draw = (currentTime: number) => {
      if (!isScrolling) {
        const elapsed = currentTime - lastTime;
        if (elapsed >= targetInterval) {
          lastTime = currentTime;

          ctx.fillStyle = `rgba(0, 0, 0, ${activeSection === 'home' ? 0.04 : 0.05})`;
          ctx.fillRect(0, 0, canvas.width, canvas.height);

          ctx.fillStyle = '#00ffff';
          ctx.font = `${fontSize}px 'Courier New', monospace`;
          
          for (let i = 0; i < drops.length; i++) {
            const char = matrix[Math.floor(Math.random() * matrix.length)];
            ctx.fillText(char, i * fontSize, drops[i] * fontSize);

            if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
              drops[i] = 0;
            }
            drops[i]++;
          }
        }
      }
      animationRef.current = requestAnimationFrame(draw);
    };

    animationRef.current = requestAnimationFrame(draw);
    window.addEventListener('resize', setupCanvas);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      window.removeEventListener('resize', setupCanvas);
    };
  }, [activeSection, isScrolling]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: -1,
        opacity: 0.5,
        pointerEvents: 'none',
        willChange: 'transform'
      }}
    />
  );
});

export default MatrixRain; 