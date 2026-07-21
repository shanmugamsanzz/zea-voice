import { useEffect } from 'react';

const HANDLE_CLASS = 'zea-column-resizer';
const LEFT_ALIGNED_HEADER = /(?:name|email|address|description|details|remark|note|message|transcript|company|organization|agent|campaign|provider|model|title|subject|reason|endpoint|website|url|file|document|knowledge|customer|developer|user)/i;

function enhanceTable(table: HTMLTableElement) {
  const headerCells = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'));
  const columnHeaders = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead tr:last-child th'));

  columnHeaders.forEach((header, columnIndex) => {
    const shouldAlignLeft = LEFT_ALIGNED_HEADER.test(header.textContent?.trim() ?? '');
    header.classList.toggle('zea-table-text-column', shouldAlignLeft);
    table.querySelectorAll<HTMLTableRowElement>('tbody tr').forEach((row) => {
      row.cells.item(columnIndex)?.classList.toggle('zea-table-text-column', shouldAlignLeft);
    });
  });

  headerCells.forEach((header) => {
    if (header.dataset.resizableColumn === 'true' || header.colSpan > 1) return;

    header.dataset.resizableColumn = 'true';
    const handle = document.createElement('span');
    handle.className = HANDLE_CLASS;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'vertical');
    handle.setAttribute('aria-label', 'Resize column');
    header.appendChild(handle);

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();

      const currentHeaders = Array.from(table.querySelectorAll<HTMLTableCellElement>('thead th'));
      const startingWidths = currentHeaders.map((cell) => cell.getBoundingClientRect().width);
      const columnIndex = currentHeaders.indexOf(header);
      if (columnIndex < 0) return;

      currentHeaders.forEach((cell, index) => {
        cell.style.width = `${startingWidths[index]}px`;
      });

      const startX = event.clientX;
      const startWidth = startingWidths[columnIndex];
      const startTableWidth = table.getBoundingClientRect().width;
      handle.classList.add('is-resizing');
      document.body.classList.add('zea-resizing-column');
      handle.setPointerCapture(event.pointerId);

      const resize = (moveEvent: PointerEvent) => {
        const nextWidth = Math.max(80, startWidth + moveEvent.clientX - startX);
        header.style.width = `${nextWidth}px`;
        table.style.width = `${Math.max(320, startTableWidth + nextWidth - startWidth)}px`;
      };

      const finish = () => {
        handle.classList.remove('is-resizing');
        document.body.classList.remove('zea-resizing-column');
        handle.removeEventListener('pointermove', resize);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
      };

      handle.addEventListener('pointermove', resize);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
    });
  });
}

export function useResizableTables() {
  useEffect(() => {
    const enhanceAllTables = (root: ParentNode = document) => {
      root.querySelectorAll<HTMLTableElement>('table').forEach(enhanceTable);
    };

    enhanceAllTables();
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) return;
          if (node.matches('table')) enhanceTable(node as HTMLTableElement);
          const parentTable = node.closest<HTMLTableElement>('table');
          if (parentTable) enhanceTable(parentTable);
          enhanceAllTables(node);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      document.querySelectorAll(`.${HANDLE_CLASS}`).forEach((handle) => handle.remove());
      document.querySelectorAll<HTMLElement>('[data-resizable-column="true"]').forEach((header) => {
        delete header.dataset.resizableColumn;
      });
      document.body.classList.remove('zea-resizing-column');
    };
  }, []);
}
