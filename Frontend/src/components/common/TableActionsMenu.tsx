import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EllipsisVertical } from 'lucide-react';

export interface TableAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface TableActionsMenuProps {
  actions: TableAction[];
  ariaLabel?: string;
}

export function TableActionsMenu({
  actions,
  ariaLabel = 'Open actions menu',
}: TableActionsMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const updatePosition = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const menuWidth = 176;
      const menuHeight = actions.length * 40 + 12;
      const viewportGap = 8;
      const left = Math.min(
        window.innerWidth - menuWidth - viewportGap,
        Math.max(viewportGap, rect.right - menuWidth),
      );
      const top = rect.bottom + menuHeight + viewportGap <= window.innerHeight
        ? rect.bottom + 6
        : Math.max(viewportGap, rect.top - menuHeight - 6);
      setPosition({ left, top });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [actions.length, open]);

  if (!actions.length) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="zea-table-actions-trigger inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition hover:border-[#dfa822]/60 hover:bg-[#dfa822]/10 hover:text-[#dfa822]"
      >
        <EllipsisVertical className="h-4 w-4" />
      </button>

      {open && createPortal(
        <>
          <button
            type="button"
            aria-label="Close actions menu"
            className="fixed inset-0 z-[9998] cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="zea-table-actions-menu fixed z-[9999] w-44 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 text-left shadow-2xl"
            style={position}
          >
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onClick();
                }}
                className={`block w-full rounded-lg px-3 py-2.5 text-left text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  action.danger
                    ? 'text-rose-600 hover:bg-rose-50'
                    : 'text-slate-700 hover:bg-[#dfa822]/10 hover:text-[#b78513]'
                }`}
              >
                {action.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
