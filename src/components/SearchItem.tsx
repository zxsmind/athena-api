import { Loader2, Check } from 'lucide-react';
import { displayQuery } from '../lib/chat-utils';
import type { Message } from '../lib/api';

export default function SearchItem({ search, index }: {
  search: NonNullable<Message['searches']>[number];
  index: number;
}) {
  return (
    <div key={index} style={{
      display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5,
      color: search.status === 'searching' ? 'var(--athena-text-3)' : 'var(--athena-text-2)',
      fontFamily: 'inherit',
    }}>
      {search.status === 'searching' ? (
        <Loader2 size={10} style={{ flexShrink: 0, animation: 'spin 1s linear infinite' }} />
      ) : (
        <Check size={10} style={{ flexShrink: 0 }} />
      )}
      <span style={{ opacity: search.status === 'searching' ? 0.8 : 0.6 }}>
        {search.status === 'searching'
          ? (search.type === 'webpage' ? 'Fetching' : 'Searching')
          : (search.type === 'webpage' ? 'Fetched' : 'Searched')
        }
      </span>
      <span style={{ color: 'var(--athena-text-2)', fontWeight: 450, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {displayQuery(search.query, search.type)}
      </span>
      {search.model && (
        <span style={{
          fontSize: 8, color: 'var(--athena-text-3)',
          background: 'rgba(var(--athena-accent-rgb), 0.04)',
          padding: '1px 4px', borderRadius: 3, marginLeft: 2,
        }}>
          {search.model}
        </span>
      )}
      {search.duration_ms !== undefined && (
        <span style={{ fontSize: 9, opacity: 0.45, fontVariantNumeric: 'tabular-nums' }}>
          {(search.duration_ms / 1000).toFixed(1)}s
        </span>
      )}
    </div>
  );
}
