import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Activity,
  BookOpen,
  Cable,
  FileSearch,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Moon,
  Plug,
  ScrollText,
  Search,
  Settings,
  Sun,
  TerminalSquare,
} from 'lucide-react';
import { useTheme } from '../lib/useTheme';
import { getAdminKey, getApiKey, maskedKey, setAdminKey, setApiKey } from '../lib/storage';
import { Badge, Button, Input } from './ui';

const playgroundNav = [
  { to: '/', label: 'Search', icon: Search },
  { to: '/contents', label: 'Contents', icon: FileSearch },
  { to: '/research', label: 'Research', icon: Activity },
  { to: '/mcp', label: 'MCP Connect', icon: Cable },
  { to: '/docs', label: 'API Reference', icon: BookOpen },
];

const adminNav = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/admin/keys', label: 'Keys', icon: KeyRound },
  { to: '/admin/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/admin/models', label: 'Models', icon: ScrollText },
  { to: '/admin/settings', label: 'Settings', icon: Settings },
  { to: '/admin/ops', label: 'Ops', icon: TerminalSquare },
];

function NavItem({ to, label, icon: Icon }: { to: string; label: string; icon: typeof Search }) {
  return (
    <NavLink
      to={to}
      end={to === '/admin'}
      className={({ isActive }) =>
        `group relative flex items-center gap-[10px] h-[34px] px-[10px] rounded-[var(--radius-1)] text-[13px] font-medium transition-colors duration-120 ${
          isActive
            ? 'text-[var(--foreground)]'
            : 'text-[var(--gray-600)] hover:text-[var(--foreground)] hover:bg-[var(--background-200)]'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="sidebar-active"
              className="absolute inset-0 rounded-[var(--radius-1)] bg-[var(--background-200)] border border-[var(--border)]"
              transition={{ type: 'spring', stiffness: 420, damping: 34 }}
            />
          )}
          <Icon size={15} className="relative z-1 shrink-0" />
          <span className="relative z-1">{label}</span>
        </>
      )}
    </NavLink>
  );
}

function ConnectionBar() {
  const location = useLocation();
  const admin = location.pathname.startsWith('/admin');

  const [key, setKey] = useState(() => (admin ? getAdminKey() : getApiKey()));
  useEffect(() => {
    setKey(admin ? getAdminKey() : getApiKey());
  }, [admin]);

  const save = (value: string) => {
    setKey(value);
    if (admin) setAdminKey(value);
    else setApiKey(value);
  };

  return (
    <div className="flex items-center gap-[8px] min-w-0 flex-1">
      {admin ? (
        <Badge tone={key ? 'ok' : 'neutral'}>{key ? 'Admin key' : 'No admin key'}</Badge>
      ) : (
        <Badge tone={key ? 'ok' : 'neutral'}>{key ? maskedKey(key) : 'No API key'}</Badge>
      )}
      <Input
        value={key}
        onChange={(event) => save(event.target.value)}
        placeholder={admin ? 'adm_… (session only)' : 'Bearer ath_…'}
        spellCheck={false}
        autoComplete="off"
        className="h-[30px] flex-1 min-w-0 max-w-[380px] text-[12px] font-mono"
      />
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  const location = useLocation();

  return (
    <div className="flex h-full bg-[var(--background)]">
      <aside className="hidden md:flex flex-col w-[var(--sidebar-width)] shrink-0 border-r border-[var(--border)] bg-[var(--background-100)]">
        <div className="flex items-center gap-[10px] h-[var(--topbar-height)] px-[16px] border-b border-[var(--border)]">
          <div className="flex items-center justify-center w-[26px] h-[26px] rounded-[var(--radius-1)] bg-[var(--accent)] text-[var(--accent-foreground)]">
            <Plug size={14} />
          </div>
          <div className="flex flex-col leading-none">
            <span className="text-[14px] font-semibold tracking-tight">Athena</span>
            <span className="text-[11px] text-[var(--gray-500)]">Research Console</span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto p-[10px] flex flex-col gap-[18px]">
          <div className="flex flex-col gap-[3px]">
            <p className="px-[10px] pb-[3px] text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">Playground</p>
            {playgroundNav.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
          <div className="flex flex-col gap-[3px]">
            <p className="px-[10px] pb-[3px] text-[11px] font-semibold uppercase tracking-wider text-[var(--gray-500)]">Admin</p>
            {adminNav.map((item) => (
              <NavItem key={item.to} {...item} />
            ))}
          </div>
        </nav>

        <div className="p-[10px] border-t border-[var(--border)]">
          <Button variant="ghost" size="sm" onClick={toggle} className="w-full justify-start">
            {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
            {theme === 'dark' ? 'Light theme' : 'Dark theme'}
          </Button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-[16px] h-[var(--topbar-height)] px-[20px] border-b border-[var(--border)] bg-[var(--background-100)]">
          <ConnectionBar />
          <span className="hidden sm:block text-[12px] font-mono text-[var(--gray-500)]">
            {location.pathname}
          </span>
        </header>

        <main className="flex-1 overflow-y-auto">
          <motion.div
            key={location.pathname}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="mx-auto max-w-[1080px] px-[20px] py-[24px]"
          >
            {children}
          </motion.div>
        </main>
      </div>
    </div>
  );
}
