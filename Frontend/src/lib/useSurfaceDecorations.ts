import { useEffect } from 'react';

const SURFACE_SELECTOR = [
  'main .bg-white',
  'main .bg-slate-50',
  'main .bg-slate-100',
  'main .bg-gray-50',
  'main div.rounded-xl.border',
  'main div.rounded-2xl.border',
  'main div.rounded-3xl.border',
  '[role="dialog"]',
  'form.bg-white',
  '.zea-login-card',
].join(',');

const EXCLUDED_SELECTOR = 'button, input, select, textarea, label, .border-dashed, .animate-pulse, [class*="placeholder"]';
const SIZE_CLASSES = ['zea-surface-pattern', 'zea-surface-pattern-sm', 'zea-surface-pattern-md', 'zea-surface-pattern-lg'];

function tonalColor(rgb: number[], target: number, amount: number) {
  const channels = rgb.map((channel) => Math.round(channel + (target - channel) * amount));
  return `rgb(${channels[0]} ${channels[1]} ${channels[2]})`;
}

function captureSurfaceColor(surface: HTMLElement) {
  if (surface.style.getPropertyValue('--zea-card-base')) return;
  const color = getComputedStyle(surface).backgroundColor;
  const match = color.match(/[\d.]+/g)?.map(Number);
  const fallback = [16, 17, 15];
  const alpha = match?.[3] ?? 1;
  const rgb = match && match.length >= 3 && alpha > 0
    ? match.slice(0, 3).map((channel, index) => Math.round(channel * alpha + fallback[index] * (1 - alpha)))
    : fallback;
  surface.style.setProperty('--zea-card-base', `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`);
  surface.style.setProperty('--zea-card-light', tonalColor(rgb, 255, 0.09));
  surface.style.setProperty('--zea-card-dark', tonalColor(rgb, 0, 0.18));
}

function updateSurfaceDecorations() {
  document.querySelectorAll<HTMLElement>(SURFACE_SELECTOR).forEach((surface) => {
    surface.classList.remove(...SIZE_CLASSES);
    if (surface.matches(EXCLUDED_SELECTOR) || surface.closest('button') || surface.closest('.border-dashed, .animate-pulse')) return;
    if (surface.parentElement?.closest(SURFACE_SELECTOR)) return;

    const { width, height } = surface.getBoundingClientRect();
    if (width < 220 || height < 110) return;

    const circleSize = Math.max(84, Math.min(116, height * 0.62));
    surface.style.setProperty('--zea-card-circle-radius', `${circleSize / 2}px`);
    surface.style.setProperty('--zea-card-circle-x', `calc(100% - ${circleSize * 0.42}px)`);
    surface.style.setProperty('--zea-card-circle-y', `${circleSize * 0.26}px`);
    captureSurfaceColor(surface);
    surface.classList.add('zea-surface-pattern');
    const area = width * height;
    surface.classList.add(area < 75_000
      ? 'zea-surface-pattern-sm'
      : area < 190_000
        ? 'zea-surface-pattern-md'
        : 'zea-surface-pattern-lg');
  });
}

export function useSurfaceDecorations() {
  useEffect(() => {
    let frame = 0;
    const scheduleUpdate = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateSurfaceDecorations);
    };

    scheduleUpdate();
    const observer = new MutationObserver(scheduleUpdate);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('resize', scheduleUpdate, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      cancelAnimationFrame(frame);
      document.querySelectorAll<HTMLElement>('.zea-surface-pattern').forEach((surface) => {
        surface.classList.remove(...SIZE_CLASSES);
        surface.style.removeProperty('--zea-card-base');
        surface.style.removeProperty('--zea-card-light');
        surface.style.removeProperty('--zea-card-dark');
        surface.style.removeProperty('--zea-card-circle-radius');
        surface.style.removeProperty('--zea-card-circle-x');
        surface.style.removeProperty('--zea-card-circle-y');
      });
    };
  }, []);
}
