import { useEffect } from 'react';

const VALUE_SELECTOR = '.text-2xl, .text-3xl, .text-4xl';
const CARD_SELECTOR = 'div.rounded-lg, div.rounded-xl, div.rounded-2xl, div.rounded-3xl';
const NUMBER_VALUE = /(?:\d|₹|\$|€|£|%)/;

function decorateKpiCards() {
  document.querySelectorAll<HTMLElement>(VALUE_SELECTOR).forEach((value) => {
    if (!NUMBER_VALUE.test(value.textContent ?? '')) return;
    const card = value.closest<HTMLElement>(CARD_SELECTOR);
    if (!card || card.closest('table') || card.matches('[role="dialog"]')) return;

    const bounds = card.getBoundingClientRect();
    if (bounds.height > 260 || bounds.width < 120) return;
    const circleSize = Math.max(84, Math.min(116, bounds.height * 0.62));
    card.style.setProperty('--zea-kpi-circle-size', `${circleSize}px`);
    card.style.setProperty('--zea-kpi-circle-top', `${circleSize * -0.24}px`);
    card.style.setProperty('--zea-kpi-circle-right', `${circleSize * -0.08}px`);
    card.classList.add('zea-kpi-card');
  });
}

export function useKpiCardDecorations() {
  useEffect(() => {
    let frame = 0;
    const scheduleDecoration = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(decorateKpiCards);
    };

    scheduleDecoration();
    const observer = new MutationObserver(scheduleDecoration);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      document.querySelectorAll<HTMLElement>('.zea-kpi-card').forEach((card) => {
        card.classList.remove('zea-kpi-card');
        card.style.removeProperty('--zea-kpi-circle-size');
        card.style.removeProperty('--zea-kpi-circle-top');
        card.style.removeProperty('--zea-kpi-circle-right');
      });
    };
  }, []);
}
