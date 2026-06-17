import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useColorMode } from '../context/ColorMode';
import { useSettingsModal } from '../context/SettingsModal';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';

interface CtxMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface CtxMenuCtx {
  show: (x: number, y: number, items: ContextMenuItem[]) => void;
  hide: () => void;
}

const CtxMenuContext = createContext<CtxMenuCtx>({
  show: () => {},
  hide: () => {},
});

// eslint-disable-next-line react-refresh/only-export-components
export function useContextMenu() {
  return useContext(CtxMenuContext);
}

export default function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<CtxMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { toggle } = useColorMode();
  const { open: openSettings } = useSettingsModal();

  const hide = useCallback(() => setMenu(null), []);

  const show = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setMenu({ x, y, items });
  }, []);

  /* Global right-click handler */
  useEffect(() => {
    const handleContext = (e: MouseEvent) => {
      /* already handled by a child (e.g. Sidebar) via preventDefault + showMenu */
      if (e.defaultPrevented) return;

      const target = e.target as HTMLElement;
      const ctxEl = target.closest('[data-ctx]') as HTMLElement | null;
      if (ctxEl) {
        const ctx = ctxEl.getAttribute('data-ctx');

        if (ctx === 'chat-message') {
          e.preventDefault();
          const msgType = ctxEl.getAttribute('data-msg-type');
          const contentEl = ctxEl.querySelector('[data-msg-content]');
          const content = contentEl?.textContent || '';
          const items: ContextMenuItem[] = [
            { label: 'Copy', onClick: () => navigator.clipboard.writeText(content) },
          ];
          if (msgType === 'assistant') {
            items.push({ label: 'Regenerate', onClick: () => window.dispatchEvent(new Event('athena:regenerate')) });
          }
          show(e.clientX, e.clientY, items);
          return;
        }

        if (ctx === 'title') {
          e.preventDefault();
          const title = ctxEl.textContent || '';
          show(e.clientX, e.clientY, [
            { label: 'Copy', onClick: () => navigator.clipboard.writeText(title) },
          ]);
          return;
        }
      }

      /* Default: anywhere else */
      e.preventDefault();
      show(e.clientX, e.clientY, [
        { label: 'New Chat', onClick: () => navigate('/') },
        { label: 'Reload', onClick: () => window.location.reload() },
        { label: 'Settings', onClick: openSettings },
      ]);
    };

    document.addEventListener('contextmenu', handleContext);
    return () => document.removeEventListener('contextmenu', handleContext);
  }, [show, navigate, toggle, openSettings]);

  /* Close on outside click / Escape */
  useEffect(() => {
    if (!menu) return;
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', handle);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handle);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menu]);

  return (
    <CtxMenuContext.Provider value={{ show, hide }}>
      {children}
      {menu && (
        <div ref={menuRef}>
          <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={hide} />
        </div>
      )}
    </CtxMenuContext.Provider>
  );
}
