'use client';

import { useRef, useEffect, useCallback } from 'react';

const MatrixRain = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback((ctx: CanvasRenderingContext2D, drops: number[], fontSize: number, matrix: string, speeds: number[]) => {
    // Semi-transparent black for trailing effect
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    ctx.font = `${fontSize}px 'Courier New', monospace`;

    for (let i = 0; i < drops.length; i++) {
      const char = matrix[Math.floor(Math.random() * matrix.length)];
      const x = i * fontSize;
      const y = drops[i] * fontSize;

      const flickerIntensity = 0.5 + Math.random() * 0.5;

      // All characters are cyan
      ctx.fillStyle = `rgba(0, 255, 255, ${flickerIntensity})`;
      
      ctx.fillText(char, x, y);
      
      // Move drop down
      drops[i] += speeds[i];

      // Reset drop when it goes off screen
      if (drops[i] * fontSize > ctx.canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
        speeds[i] = 0.5 + Math.random() * 1.5; // Reset speed
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    const matrix = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンQNET0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const fontSize = 16;
    let columns = 0;
    let drops: number[] = [];
    let speeds: number[] = [];

    const setup = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.floor(canvas.width / fontSize);
      drops = [];
      speeds = [];
      for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -canvas.height; // Start off-screen
        speeds[i] = 0.5 + Math.random() * 1.5;
      }
    };
    
    setup();

    const render = () => {
      draw(ctx, drops, fontSize, matrix, speeds);
      animationFrameId = window.requestAnimationFrame(render);
    };
    
    render();
    
    window.addEventListener('resize', setup);
    
    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', setup);
    };
  }, [draw]);

  return (
    <canvas
      id="matrix-rain-canvas"
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        zIndex: -1,
        opacity: 0.7,
        pointerEvents: 'none',
        display: 'block'
      }}
    />
  );
};

export default MatrixRain; 