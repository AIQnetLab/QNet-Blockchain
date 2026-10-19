'use client';

// The site's background: falling cyan characters behind every page, My node's included (owner, 04.10); the panels of a
// page are drawn over it, opaque and blurred, so the text stays readable.

import { useRef, useEffect, useCallback } from 'react';
import { frameLoop } from '@/lib/frame-loop';

// About 30 frames a second, and none while the page is hidden or the system asks for reduced motion. The look is that
// of 60 frames a second: a frame stands for two of those, so a drop falls two steps, the trail fades as much as two 5%
// fades and a drop below the screen restarts as often per second.
const RAIN_FPS = 30;
const STEPS = 60 / RAIN_FPS;
const FADE = (1 - 0.95 ** STEPS).toFixed(4);
const RESTART = 1 - 0.975 ** STEPS;

const MatrixRain = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback((ctx: CanvasRenderingContext2D, drops: number[], fontSize: number, matrix: string, speeds: number[]) => {
    // Semi-transparent black for trailing effect
    ctx.fillStyle = `rgba(0, 0, 0, ${FADE})`;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    for (let i = 0; i < drops.length; i++) {
      const char = matrix[Math.floor(Math.random() * matrix.length)];
      const x = i * fontSize;
      const y = drops[i] * fontSize;

      const flickerIntensity = 0.5 + Math.random() * 0.5;

      // All characters are cyan
      ctx.fillStyle = `rgba(0, 255, 255, ${flickerIntensity})`;

      ctx.fillText(char, x, y);

      // Move drop down
      drops[i] += speeds[i] * STEPS;

      // Reset drop when it goes off screen
      if (drops[i] * fontSize > ctx.canvas.height && Math.random() < RESTART) {
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

    const matrix = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンQNET0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const fontSize = 16;
    // The site's one monospace stack (--font-mono in globals.css), read once.
    const font = `${fontSize}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || 'monospace'}`;
    let columns = 0;
    let drops: number[] = [];
    let speeds: number[] = [];

    const setup = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      // A new size resets the context, its font included.
      ctx.font = font;
      columns = Math.floor(canvas.width / fontSize);
      drops = [];
      speeds = [];
      for (let i = 0; i < columns; i++) {
        drops[i] = Math.random() * -canvas.height; // Start off-screen
        speeds[i] = 0.5 + Math.random() * 1.5;
      }
    };

    setup();

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const loop = frameLoop(() => draw(ctx, drops, fontSize, matrix, speeds), RAIN_FPS, () => !document.hidden && !motion.matches, window);
    loop.sync();

    window.addEventListener('resize', setup);
    document.addEventListener('visibilitychange', loop.sync);
    motion.addEventListener('change', loop.sync);

    return () => {
      loop.stop();
      window.removeEventListener('resize', setup);
      document.removeEventListener('visibilitychange', loop.sync);
      motion.removeEventListener('change', loop.sync);
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
