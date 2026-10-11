import { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Page } from '../components/Page';
import { Badge, Button, Card, Field, Textarea, useToast } from '../components/ui';
import { ApiError, contents, type ContentsResponse } from '../lib/api';

export function ContentsPage() {
  const toast = useToast();
  const [raw, setRaw] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ContentsResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const urls = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20);

  const submit = async () => {
    if (urls.length === 0) return;
    setLoading(true);
    setResult(null);
    try {
      setResult(await contents(urls));
    } catch (error) {
      toast(
        error instanceof ApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : 'Extraction failed.',
        'danger',
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page
      title="Contents"
      description="Readable text from up to 20 URLs. Loopback, private and metadata addresses are refused in any IP notation, and every redirect hop is re-validated."
      actions={result ? <Badge>{`${result.documents.length} read · ${result.failed.length} failed`}</Badge> : undefined}
    >
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] gap-[16px] items-start">
        <Card className="p-[16px] flex flex-col gap-[14px]">
          <Field label="URLs" hint="One per line. Each up to 2048 characters.">
            {(id) => (
              <Textarea
                id={id}
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                placeholder={'https://example.org/a\nhttps://example.org/b'}
                className="min-h-[160px] font-mono text-[12px]"
              />
            )}
          </Field>
          <div className="flex items-center justify-between text-[12px] text-[var(--gray-500)]">
            <span>{urls.length} / 20 queued</span>
          </div>
          <Button variant="primary" loading={loading} onClick={() => void submit()}>
            {loading ? 'Extracting…' : 'Read pages'}
          </Button>
        </Card>

        <div className="flex flex-col gap-[8px] min-w-0">
          {!loading && !result && (
            <Card className="p-[24px] text-center text-[13px] text-[var(--gray-500)]">
              Extracted documents appear here with their content digest.
            </Card>
          )}
          {result?.documents.map((document, index) => {
            const open = expanded[document.url] ?? false;
            return (
              <motion.div
                key={document.url}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(index * 0.04, 0.2) }}
              >
                <Card className="overflow-hidden">
                  <button
                    className="w-full flex items-center gap-[8px] px-[14px] py-[10px] text-left hover:bg-[var(--background-200)] transition-colors duration-120"
                    onClick={() => setExpanded((current) => ({ ...current, [document.url]: !open }))}
                  >
                    {open ? <ChevronDown size={14} className="shrink-0 text-[var(--gray-500)]" /> : <ChevronRight size={14} className="shrink-0 text-[var(--gray-500)]" />}
                    <span className="text-[13px] font-medium truncate flex-1">{document.title || document.url}</span>
                    <span className="text-[11px] font-mono text-[var(--gray-500)] shrink-0">
                      {document.content.length.toLocaleString()} chars
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-[var(--border)]">
                      <p className="px-[14px] pt-[10px] text-[12px] font-mono text-[var(--gray-500)] break-all">{document.url}</p>
                      <pre className="overflow-x-auto max-h-[360px] px-[14px] pb-[12px] pt-[6px] text-[12px] leading-relaxed whitespace-pre-wrap">
                        {document.content}
                      </pre>
                      <p className="px-[14px] pb-[10px] text-[11px] font-mono text-[var(--gray-500)]">
                        sha256 {document.content_digest.slice(0, 24)}…
                      </p>
                    </div>
                  )}
                </Card>
              </motion.div>
            );
          })}
          {result && result.failed.length > 0 && (
            <Card className="p-[14px] flex flex-col gap-[6px] border-[var(--danger)]!">
              <p className="text-[13px] font-medium text-[var(--danger)]">Failed</p>
              {result.failed.map((failure) => (
                <p key={failure.url} className="text-[12px] font-mono text-[var(--gray-600)] break-all">
                  {failure.url} — {failure.error}
                </p>
              ))}
            </Card>
          )}
        </div>
      </div>
    </Page>
  );
}
