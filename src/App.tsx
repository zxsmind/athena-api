import { useState, useCallback, useRef, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Menu } from 'lucide-react';
import useTheme from './theme';
import { ColorModeProvider } from './context/ColorMode';
import { SettingsModalProvider, useSettingsModal } from './context/SettingsModal';
import LiquidBackground from './components/LiquidBackground';
import type { LiquidBackgroundHandle } from './components/LiquidBackground';
import Sidebar from './components/Sidebar';
import ProgressBar from './components/ProgressBar';
import ContextMenuProvider from './components/ContextMenuProvider';
import Landing from './pages/Landing';
import Chat from './pages/Chat';
import SettingsModal from './components/SettingsModal';
import { fetchConversations, createConversation, renameConversation, deleteConversation } from './lib/api';
import type { Message } from './lib/api';

interface Conversation {
  id: string;
  query: string;
  title: string | null;
  timestamp: Date;
}

function Layout() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [chatMessages, setChatMessages] = useState<Record<string, Message[]>>({});
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const bgRef = useRef<LiquidBackgroundHandle>(null);
  const isMobile = useMediaQuery('(max-width: 1023px)');

  const { isOpen, open, close } = useSettingsModal();

  useEffect(() => {
    fetchConversations().then(list => {
      setConversations(list.map(c => ({ ...c, timestamp: new Date(c.timestamp) })));
    });
  }, []);

  useEffect(() => {
    bgRef.current?.setActive(location.pathname.startsWith('/c/'));
  }, [location.pathname]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && sidebarOpen) setSidebarOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sidebarOpen]);

function genId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

  const handleSearch = useCallback(async (query: string, mode?: 'quick' | 'deep') => {
    const id = genId();
    navigate(`/c/${id}`, { state: { query, mode } });

    setLoading(true);
    createConversation(id, query)
      .then(list => {
        setConversations(list.map(c => ({ ...c, timestamp: new Date(c.timestamp) })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [navigate]);

  const handleNewChat = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const handleRename = useCallback(async (id: string) => {
    const title = window.prompt('New name:');
    if (!title || !title.trim()) return;
    await renameConversation(id, title.trim());
    const list = await fetchConversations();
    setConversations(list.map(c => ({ ...c, timestamp: new Date(c.timestamp) })));
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (!window.confirm('Delete this conversation?')) return;
    await deleteConversation(id);
    setConversations(prev => prev.filter(c => c.id !== id));
    if (location.pathname === `/c/${id}`) {
      navigate('/');
    }
  }, [location.pathname, navigate]);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      <LiquidBackground triggerRef={bgRef} />
      <ProgressBar visible={loading} />

      <ContextMenuProvider>
        <Sidebar
          conversations={conversations}
          onNewChat={handleNewChat}
          onRename={handleRename}
          onDelete={handleDelete}
          onOpenSettings={() => { open(); setSidebarOpen(false); }}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
        />

        <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {isMobile && location.pathname === '/' && (
            <button
              onClick={() => setSidebarOpen(true)}
              title="Open sidebar"
              style={{
                position: 'absolute', top: 12, left: 12, zIndex: 10,
                width: 32, height: 32, borderRadius: 8, border: 'none',
                background: 'none', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--athena-text-2)',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--athena-border)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <Menu size={18} />
            </button>
          )}
          <Routes>
            <Route path="/" element={<Landing onSearch={handleSearch} />} />
            <Route
              path="/c/:id"
              element={
                <Chat
                  chatMessages={chatMessages}
                  onUpdateMessages={setChatMessages}
                  conversations={conversations}
                  onOpenSidebar={() => setSidebarOpen(true)}
                />
              }
            />
          </Routes>
        </main>
      </ContextMenuProvider>

      <SettingsModal open={isOpen} onClose={close} />
    </div>
  );
}

export default function App() {
  const theme = useTheme();
  return (
    <ColorModeProvider>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <BrowserRouter>
          <SettingsModalProvider>
            <Layout />
          </SettingsModalProvider>
        </BrowserRouter>
      </ThemeProvider>
    </ColorModeProvider>
  );
}
