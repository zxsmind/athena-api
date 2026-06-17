import { useNavigate, useLocation } from 'react-router-dom';
import {
  Plus,
  Moon,
  Sun,
  Settings,
  MessageSquare,
  X,
} from 'lucide-react';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useColorMode } from '../context/ColorMode';
import { useContextMenu } from './ContextMenuProvider';

interface Conversation {
  id: string;
  query: string;
  title?: string | null;
  timestamp: Date;
}

const SIDEBAR_W = 260;

interface SidebarProps {
  conversations: Conversation[];
  onNewChat: () => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  open?: boolean;
  onClose?: () => void;
}

export default function Sidebar({ conversations, onNewChat, onRename, onDelete, onOpenSettings, open, onClose }: SidebarProps) {
  const { mode, toggle } = useColorMode();
  const navigate = useNavigate();
  const location = useLocation();
  const dark = mode === 'dark';
  const { show: showMenu } = useContextMenu();
  const isMobile = useMediaQuery('(max-width: 1023px)');

  const content = (
    <div
      className="glass-sidebar"
      style={{
        height: '100%',
        borderRadius: 20,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      {isMobile && onClose && (
        <button
          onClick={onClose}
          title="Close sidebar"
          style={{
            position: 'absolute', top: 10, right: 10, zIndex: 3,
            width: 28, height: 28, borderRadius: 6, border: 'none',
            background: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--athena-text-3)',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--athena-border)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
        >
          <X size={14} />
        </button>
      )}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: '0 8px',
          overflow: 'hidden',
        }}
      >
          {/* Header */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              padding: '14px 6px 10px',
              flexShrink: 0,
            }}
          >
            <AthenaLogo dark={dark} />
            <span
              className="font-outfit"
              style={{
                fontSize: 12,
                letterSpacing: '0.28em',
                fontWeight: 500,
                color: 'var(--athena-text)',
                userSelect: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              ATHENA
            </span>
          </div>

          {/* New Chat */}
          <div style={{ padding: '0 6px 8px', flexShrink: 0 }}>
            <button
              onClick={onNewChat}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '9px 14px',
                background: dark
                  ? 'rgba(255,255,255,0.04)'
                  : 'rgba(0,0,0,0.035)',
                border: `0.5px solid ${
                  dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
                }`,
                borderRadius: 12,
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 500,
                color: 'var(--athena-text)',
                fontFamily: 'inherit',
                transition:
                  'background 160ms var(--ease-out), transform 160ms var(--ease-spring), border-color 160ms',
              }}
              onMouseEnter={(e) => {
                const el = e.currentTarget;
                el.style.background = dark
                  ? 'rgba(255,255,255,0.07)'
                  : 'rgba(0,0,0,0.06)';
                el.style.borderColor = dark
                  ? 'rgba(255,255,255,0.10)'
                  : 'rgba(0,0,0,0.08)';
                el.style.transform = 'scale(1.01)';
              }}
              onMouseLeave={(e) => {
                const el = e.currentTarget;
                el.style.background = dark
                  ? 'rgba(255,255,255,0.04)'
                  : 'rgba(0,0,0,0.035)';
                el.style.borderColor = dark
                  ? 'rgba(255,255,255,0.06)'
                  : 'rgba(0,0,0,0.05)';
                el.style.transform = 'scale(1)';
              }}
              onMouseDown={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'scale(0.97)';
              }}
              onMouseUp={(e) => {
                (e.currentTarget as HTMLElement).style.transform = 'scale(1.01)';
              }}
              title="New search"
            >
              <Plus size={14} style={{ flexShrink: 0 }} strokeWidth={2} />
              <span>New search</span>
            </button>
          </div>

          {/* Divider */}
          <div
            style={{
              height: 0.5,
              margin: '0 10px 8px',
              background: dark
                ? 'rgba(255,255,255,0.04)'
                : 'rgba(0,0,0,0.04)',
              flexShrink: 0,
            }}
          />

          {/* Conversations */}
          <div
            style={{
              flex: 1,
              overflow: 'hidden auto',
              padding: '0 2px',
            }}
          >
            <div
              className="font-mono"
              style={{
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--athena-text-3)',
                padding: '2px 10px 6px',
                whiteSpace: 'nowrap',
              }}
            >
              Recent
            </div>

            {conversations.length === 0 ? (
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--athena-text-3)',
                  padding: '2px 10px',
                  whiteSpace: 'nowrap',
                }}
              >
                No searches yet
              </div>
            ) : (
              <ul
                style={{
                  listStyle: 'none',
                  padding: 0,
                  margin: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 1,
                }}
              >
                {conversations.map((conv) => {
                  const active = location.pathname === `/c/${conv.id}`;
                  return (
                    <li key={conv.id}>
                      <button
                        onClick={() => navigate(`/c/${conv.id}`)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          showMenu(e.clientX, e.clientY, [
                            { label: 'Rename', onClick: () => onRename(conv.id) },
                            { label: 'Delete', onClick: () => onDelete(conv.id), danger: true },
                          ]);
                        }}
                        title={conv.title ?? conv.query}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          padding: '8px 10px',
                          background: active
                            ? dark
                              ? 'rgba(255,255,255,0.055)'
                              : 'rgba(0,0,0,0.05)'
                            : 'none',
                          border: active
                            ? `0.5px solid ${
                                dark
                                  ? 'rgba(255,255,255,0.08)'
                                  : 'rgba(0,0,0,0.06)'
                              }`
                            : '0.5px solid transparent',
                          borderRadius: 10,
                          cursor: 'pointer',
                          fontSize: 12,
                          color: active
                            ? 'var(--athena-text)'
                            : 'var(--athena-text-2)',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                          transition:
                            'background 160ms var(--ease-out), color 160ms, border-color 160ms',
                          overflow: 'hidden',
                        }}
                        onMouseEnter={(e) => {
                          if (!active) {
                            const el = e.currentTarget;
                            el.style.background = dark
                              ? 'rgba(255,255,255,0.03)'
                              : 'rgba(0,0,0,0.025)';
                            el.style.color = 'var(--athena-text)';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!active) {
                            const el = e.currentTarget;
                            el.style.background = 'none';
                            el.style.color = 'var(--athena-text-2)';
                          }
                        }}
                      >
                        <MessageSquare
                          size={12}
                          style={{
                            flexShrink: 0,
                            color: active
                              ? 'var(--athena-text-2)'
                              : 'var(--athena-text-3)',
                          }}
                        />
                        <span
                          ref={el => {
                            if (el) {
                              const overflows = el.scrollWidth > el.clientWidth;
                              el.style.maskImage = overflows ? 'linear-gradient(to right, black 70%, transparent 95%)' : 'none';
                            }
                          }}
                          style={{
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            fontSize: 11.5,
                            maxWidth: 170,
                          }}
                        >
                          {conv.title ?? conv.query}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div
            style={{
              flexShrink: 0,
              padding: '6px 6px 10px',
              borderTop: `0.5px solid ${
                dark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)'
              }`,
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            <SidebarFooterBtn
              icon={dark ? <Sun size={13} /> : <Moon size={13} />}
              label={dark ? 'Light' : 'Dark'}
              dark={dark}
              onClick={toggle}
            />
            <SidebarFooterBtn
              icon={<Settings size={13} />}
              label="Settings"
              dark={dark}
              onClick={onOpenSettings}
            />
          </div>
        </div>
      </div>
    );

  if (isMobile) {
    return (
      <>
        <div
          onClick={onClose}
          style={{
            position: 'fixed', inset: 0, zIndex: 998,
            background: dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.25)',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: 'opacity 300ms var(--ease-out)',
          }}
        />
        <aside
          style={{
            position: 'fixed', left: 0, top: 0, bottom: 0, zIndex: 999,
            width: SIDEBAR_W, padding: '10px 8px',
            transform: open ? 'translateX(0)' : 'translateX(-100%)',
            transition: 'transform 300ms var(--ease-out)',
            outline: 'none',
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Sidebar"
        >
          {content}
        </aside>
      </>
    );
  }

  return (
    <aside
      style={{
        position: 'relative',
        zIndex: 20,
        height: '100%',
        flexShrink: 0,
        width: SIDEBAR_W,
        padding: '10px 8px',
      }}
    >
      {content}
    </aside>
  );
}

function AthenaLogo({ dark }: { dark: boolean }) {
  const fill = dark ? '#f5f5ff' : '#0a0a12';
  return (
    <svg viewBox="0 0 1024 1024" width="36" height="36" style={{ flexShrink: 0 }}>
      <g transform="translate(0,1024) scale(0.1,-0.1)" fill={fill}>
        <path d="M5295 7911 c-86 -25 -125 -44 -207 -97 -98 -63 -189 -153 -254 -251 -145 -217 -180 -453 -118 -788 34 -181 37 -343 10 -444 -26 -96 -88 -212 -158 -292 -34 -40 -145 -158 -247 -264 -269 -276 -351 -405 -402 -631 -28 -125 -31 -350 -6 -459 66 -291 249 -563 484 -718 71 -46 225 -127 243 -127 5 0 10 23 10 53 0 53 18 137 38 174 10 18 5 25 -41 62 -110 88 -192 216 -233 361 -25 89 -25 271 -1 360 48 176 114 270 364 514 291 285 354 375 398 570 l22 101 32 -50 c91 -144 95 -330 11 -503 -44 -87 -77 -124 -347 -382 -103 -99 -125 -125 -156 -190 -97 -202 -66 -382 94 -554 l71 -76 46 53 c25 28 202 210 394 402 191 193 375 385 407 429 72 96 131 214 162 326 21 76 24 105 23 265 0 166 -3 187 -27 268 -61 200 -109 272 -513 772 -198 244 -266 401 -265 610 0 120 17 192 72 304 30 60 60 103 109 152 37 38 62 69 56 68 -6 0 -38 -8 -71 -18z" />
        <path d="M6184 5941 c95 -186 107 -531 28 -761 -30 -87 -80 -179 -137 -255 -30 -38 -315 -333 -635 -654 l-581 -583 3 -702 3 -701 24 -52 c62 -139 224 -201 357 -139 58 27 116 83 148 141 21 40 21 47 24 665 l3 625 373 375 c389 391 459 472 538 626 101 195 141 376 141 629 0 226 -37 392 -130 580 -30 60 -167 255 -179 255 -2 0 7 -22 20 -49z" />
      </g>
    </svg>
  );
}

function SidebarFooterBtn({
  icon,
  label,
  dark,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  dark: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '7px 10px',
        background: 'none',
        border: '0.5px solid transparent',
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 11,
        color: 'var(--athena-text-3)',
        fontFamily: 'inherit',
        transition:
          'background 160ms var(--ease-out), color 160ms, border-color 160ms',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget;
        el.style.background = dark
          ? 'rgba(255,255,255,0.04)'
          : 'rgba(0,0,0,0.035)';
        el.style.color = 'var(--athena-text-2)';
        el.style.borderColor = dark
          ? 'rgba(255,255,255,0.06)'
          : 'rgba(0,0,0,0.04)';
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget;
        el.style.background = 'none';
        el.style.color = 'var(--athena-text-3)';
        el.style.borderColor = 'transparent';
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
