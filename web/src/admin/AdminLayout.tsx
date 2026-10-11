import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Lock } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Spinner } from '../components/ui';
import { ApiError, analytics } from '../lib/api';
import { getAdminKey, setAdminKey } from '../lib/storage';

type GateState = 'checking' | 'locked' | 'forbidden' | 'open';

/**
 * The gate probes /analytics with the stored admin key: a 401 means the key is
 * missing or wrong (the prompt stays), a 403 means this machine is not on the
 * local network (no key can help), and anything else opens the section. The
 * server enforces the real rule on every call; this only shapes the first
 * screen.
 */
export function AdminLayout() {
  const [state, setState] = useState<GateState>('checking');

  const probe = () => {
    setState('checking');
    analytics(1)
      .then(() => setState('open'))
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) setState('locked');
        else if (error instanceof ApiError && error.status === 403) setState('forbidden');
        else setState('locked');
      });
  };

  useEffect(probe, []);

  if (state === 'checking') {
    return (
      <Card className="p-[48px] flex items-center justify-center">
        <Spinner label="Checking operator credentials…" />
      </Card>
    );
  }

  if (state === 'forbidden') {
    return (
      <Card className="p-[32px] flex flex-col items-center gap-[10px] text-center">
        <Badge tone="danger">LOCAL_MANAGEMENT_ONLY</Badge>
        <p className="text-[14px] font-medium">This console is running outside the server's local network.</p>
        <p className="text-[13px] text-[var(--gray-600)] max-w-[420px]">
          Key management and analytics are reachable only from the machine Athena runs on (or its private network).
          Open the console from that host, or manage keys with <span className="font-mono">athena keys</span> over SSH.
        </p>
      </Card>
    );
  }

  if (state === 'locked') {
    return <AdminGate onUnlock={probe} />;
  }

  return <Outlet />;
}

function AdminGate({ onUnlock }: { onUnlock: () => void }) {
  const [key, setKey] = useState(() => getAdminKey());

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.24 }}>
      <Card className="p-[32px] flex flex-col items-center gap-[14px] text-center max-w-[520px] mx-auto">
        <div className="flex items-center justify-center w-[40px] h-[40px] rounded-full bg-[var(--background-200)] border border-[var(--border)]">
          <Lock size={18} />
        </div>
        <div className="flex flex-col gap-[4px]">
          <h1 className="text-[18px] font-semibold tracking-tight">Operator access</h1>
          <p className="text-[13px] text-[var(--gray-600)]">
            The admin key guards key management and analytics. It was printed once on first boot — find it with{' '}
            <span className="font-mono">athena admin-key show</span>. It is kept in this tab's session only.
          </p>
        </div>
        <div className="w-full flex flex-col gap-[10px]">
          <Field label="Admin key">
            {(id) => (
              <Input
                id={id}
                value={key}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setAdminKey(key.trim());
                    onUnlock();
                  }
                }}
                placeholder="adm_…"
                className="font-mono text-[12px]"
              />
            )}
          </Field>
          <Button
            variant="primary"
            onClick={() => {
              setAdminKey(key.trim());
              onUnlock();
            }}
          >
            Unlock
          </Button>
        </div>
      </Card>
    </motion.div>
  );
}
