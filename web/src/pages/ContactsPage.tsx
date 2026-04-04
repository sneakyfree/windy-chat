import { useState, useCallback } from 'react';
import { env } from '../env';
import TrustBadge from '../components/TrustBadge';

interface SearchResult {
  userId: string;
  displayName: string;
  matchType: string;
  verified?: boolean;
}

export default function ContactsPage({ userId: _userId }: { userId: string | null }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  const search = useCallback(async () => {
    if (!query || query.length < 2) return;
    setSearching(true);
    try {
      const token = localStorage.getItem('windy_jwt');
      const res = await fetch(`${env.directoryUrl}/search?q=${encodeURIComponent(query)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setResults(data.results || []);
      }
    } catch (err) {
      console.warn('Search failed:', err);
    } finally {
      setSearching(false);
    }
  }, [query]);

  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      {/* Header */}
      <div className="px-6 py-5 border-b" style={{ borderColor: 'var(--bg-tertiary)' }}>
        <h1 className="text-lg font-bold mb-4" style={{ color: 'var(--text-primary)' }}>Contacts</h1>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Search by name, email, or phone..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && search()}
            className="flex-1 px-4 py-2.5 rounded-xl text-sm outline-none"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
          />
          <button
            onClick={search}
            disabled={query.length < 2 || searching}
            className="px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {searching ? '...' : 'Search'}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {results.length === 0 && !searching && (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">👥</div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              Search for people and agents to connect with
            </p>
          </div>
        )}

        {results.map(user => {
          const isAgent = user.userId.startsWith('bot_') || user.userId.startsWith('agent_');
          return (
            <div
              key={user.userId}
              className="flex items-center gap-4 px-6 py-4 border-b transition-colors cursor-pointer"
              style={{ borderColor: 'var(--bg-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              {/* Avatar */}
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-lg shrink-0"
                style={{
                  background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
                  border: isAgent ? '1px solid var(--accent)' : 'none',
                }}
              >
                {isAgent ? '🪰' : user.displayName?.charAt(0)?.toUpperCase() || '?'}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                    {user.displayName}
                  </span>
                  {isAgent && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                      AI Agent
                    </span>
                  )}
                  {user.verified && <TrustBadge score={null} passportId={user.userId} />}
                </div>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                  @{user.userId}
                  {user.matchType && <span className="ml-2 opacity-60">matched by {user.matchType}</span>}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-2 shrink-0">
                <button
                  className="px-4 py-2 rounded-lg text-xs font-medium"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  💬 Message
                </button>
                <button
                  className="px-4 py-2 rounded-lg text-xs font-medium"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                  + Follow
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
