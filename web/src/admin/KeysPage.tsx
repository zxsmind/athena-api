import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Trash2 } from 'lucide-react';
import { Page } from '../components/Page';
import { Badge, Button, Card, Dialog, Field, Input, Select, Table, Td, useToast } from '../components/ui';
import { ApiError, createKey, listKeys, revokeKey, type PublicApiKey } from '../lib/api';

const EMPTY_FORM = { name: '', plan: 'free' as PublicApiKey['plan'] };

export function AdminKeys() {
  const toast = useToast();
  const [keys, setKeys] = useState<PublicApiKey[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [created, setCreated] = useState<{ key: PublicApiKey; secret: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PublicApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys((await listKeys()).keys);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'Keys could not be loaded.', 'danger');
      setKeys([]);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCreate = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    try {
      const result = await createKey(form.name.trim(), form.plan);
      setCreated(result);
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The key could not be created.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  const confirmRevoke = async () => {
    if (!revokeTarget) return;
    setBusy(true);
    try {
      await revokeKey(revokeTarget.id);
      toast(`Key ${revokeTarget.id} revoked.`);
      setRevokeTarget(null);
      await load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The key could not be revoked.', 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page
      title="Keys"
      description="API keys are the only credential a client needs. Secrets are hashed server-side and shown exactly once, at creation."
      actions={
        <Button variant="primary" size="md" onClick={() => setCreateOpen(true)}>
          <Plus size={14} />
          New key
        </Button>
      }
    >
      <Card className="overflow-hidden">
        {keys === null && <div className="p-[32px] text-center text-[13px] text-[var(--gray-500)]">Loading keys…</div>}
        {keys?.length === 0 && (
          <div className="p-[48px] text-center text-[13px] text-[var(--gray-500)]">
            No keys yet. Create one with “New key” or <span className="font-mono">athena keys create</span>.
          </div>
        )}
        {keys && keys.length > 0 && (
          <Table head={['ID', 'Name', 'Plan', 'Prefix', 'Created', 'Last used', 'State', '']}>
            {keys.map((key, index) => (
              <motion.tr
                key={key.id}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.24) }}
                className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--background-200)] transition-colors duration-120"
              >
                <Td mono>{key.id}</Td>
                <Td>{key.name}</Td>
                <Td>
                  <Badge>{key.plan}</Badge>
                </Td>
                <Td mono className="text-[var(--gray-500)]">{key.prefix}…</Td>
                <Td mono className="text-[var(--gray-500)]">{key.createdAt.slice(0, 16).replace('T', ' ')}</Td>
                <Td mono className="text-[var(--gray-500)]">
                  {key.lastUsedAt ? key.lastUsedAt.slice(0, 16).replace('T', ' ') : 'never'}
                </Td>
                <Td>
                  {key.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="ok">active</Badge>}
                </Td>
                <Td>
                  {!key.revokedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setRevokeTarget(key)}>
                      <Trash2 size={13} />
                      Revoke
                    </Button>
                  )}
                </Td>
              </motion.tr>
            ))}
          </Table>
        )}
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create an API key"
        description="The secret is returned once and stored only as a hash. Save it now."
      >
        <div className="flex flex-col gap-[14px]">
          <Field label="Name" hint="A human label: letters, digits, spaces and inner punctuation.">
            {(id) => (
              <Input
                id={id}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="my-app"
                onKeyDown={(event) => event.key === 'Enter' && void submitCreate()}
              />
            )}
          </Field>
          <Field label="Plan" hint="Sets the daily credit allowance, concurrency and rate limits.">
            {(id) => (
              <Select
                id={id}
                value={form.plan}
                onChange={(event) => setForm({ ...form, plan: event.target.value as PublicApiKey['plan'] })}
              >
                <option value="free">free — 1 credit/day</option>
                <option value="paid">paid — 50 credits/day</option>
                <option value="enterprise">enterprise — 500 credits/day</option>
              </Select>
            )}
          </Field>
          <div className="flex justify-end gap-[8px]">
            <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void submitCreate()}>
              Create key
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={created !== null} onClose={() => setCreated(null)} title="Secret — shown once">
        <div className="flex flex-col gap-[14px]">
          <p className="text-[13px] text-[var(--gray-600)]">
            Store <span className="font-mono">{created?.key.name}</span> now; this exact value cannot be retrieved again.
          </p>
          <code className="block rounded-[var(--radius-1)] border border-[var(--border)] bg-[var(--background-200)] px-[12px] py-[10px] text-[12px] font-mono break-all">
            {created?.secret}
          </code>
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setCreated(null)}>
              I saved it
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title={`Revoke ${revokeTarget?.id}?`}
        description="The key stops working immediately. Its past usage stays in the totals."
      >
        <div className="flex justify-end gap-[8px]">
          <Button onClick={() => setRevokeTarget(null)}>Keep</Button>
          <Button variant="danger" loading={busy} onClick={() => void confirmRevoke()}>
            Revoke
          </Button>
        </div>
      </Dialog>
    </Page>
  );
}
