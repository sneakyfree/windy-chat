import { useState, useCallback } from 'react';
import { env } from '../env';
import TrustBadge from '../components/TrustBadge';
import { createDMRoom } from '../lib/matrix';
import { followUser, unfollowUser } from '../lib/api';

interface SearchResult {
  userId: string;
  displayName: string;
  matchType: string;
  verified?: boolean;
  matrixUserId?: string | null;
}

export default function ContactsPage({
  userId: _userId,
  onOpenChat,
  onNavigateToProfile,
}: {
  userId: string | null;
  onOpenChat?: (roomId: string) => void;
  onNavigateToProfile?: (userId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  // Tracks per-row DM-open + follow state so the row buttons reflect work
  // in flight. Maps userId → boolean.
  const [dmOpening, setDmOpening] = useState<Record<string, boolean>>({});
  const [following, setFollowing] = useState<Record<string, boolean>>({});
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const handleMessage = useCallback(async (user: SearchResult) => {
    setRowError(s => ({ ...s, [user.userId]: '' }));
    // Derive a Matrix ID — prefer the explicit field, fall back to deriving
    // from userId for bot/agent localparts.
    let mxid = user.matrixUserId || null;
    if (!mxid && (user.userId.startsWith('bot_') || user.userId.startsWith('agent_'))) {
      mxid = `@${user.userId}:chat.windychat.ai`;
    }
    if (!mxid) {
      setRowError(s => ({ ...s, [user.userId]: 'No Windy Chat handle.' }));
      return;
    }
    setDmOpening(s => ({ ...s, [user.userId]: true }));
    try {
      const roomId = await createDMRoom(mxid);
      onOpenChat?.(roomId);
    } catch (err: any) {
      setRowError(s => ({ ...s, [user.userId]: err?.message || 'Could not open chat.' }));
    } finally {
      setDmOpening(s => ({ ...s, [user.userId]: false }));
    }
  }, [onOpenChat]);

  const handleFollow = useCallback(async (user: SearchResult) => {
    const wasFollowing = !!following[user.userId];
    setFollowing(s => ({ ...s, [user.userId]: !wasFollowing }));
    try {
      if (wasFollowing) {
        await unfollowUser(user.userId);
      } else {
        await followUser(user.userId);
      }
    } catch {
      // Revert on failure.
      setFollowing(s => ({ ...s, [user.userId]: wasFollowing }));
    }
  }, [following]);

  const search = useCallback(async () => {
    if (!query || query.length < 2) return;
    setSearching(true);
    setSearchError(null);
    setHasSearched(true);
    try {
      const token = localStorage.getItem('windy_jwt');
      const res = await fetch(`${env.directoryUrl}/search?q=${encodeURIComponent(query)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json();
        setResults(data.results || []);
      } else if (res.status === 401) {
        // Pro JWT expired — most common failure mode since the JWT
        // is short-lived (15min TTL). Tell the user how to recover
        // rather than mis-labeling this as a backend outage.
        setSearchError('Your session expired. Re-open Windy Chat from your Windy Word dashboard to refresh.');
      } else if (res.status === 403) {
        setSearchError('Access denied (HTTP 403). If this persists, contact support.');
      } else {
        setSearchError(`Search unavailable (HTTP ${res.status}) — try again in a moment.`);
      }
    } catch {
      setSearchError('Search unavailable — check your connection.');
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
        {searchError && (
          <div className="text-center py-12">
            <div className="text-3xl mb-3">⚠️</div>
            <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{searchError}</p>
            <button onClick={search} className="px-4 py-2 rounded-xl text-sm" style={{ background: 'var(--accent)', color: 'white' }}>Retry</button>
          </div>
        )}

        {!searchError && results.length === 0 && !searching && (
          <div className="text-center py-16">
            <div className="text-4xl mb-3">👥</div>
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              {hasSearched ? 'No results found — try a different search' : 'Search for people and agents to connect with'}
            </p>
          </div>
        )}

        {results.map(user => {
          const isAgent = user.userId.startsWith('bot_') || user.userId.startsWith('agent_');
          const isFollowing = !!following[user.userId];
          const isOpening = !!dmOpening[user.userId];
          const error = rowError[user.userId];
          return (
            <div
              key={user.userId}
              className="px-6 py-4 border-b"
              style={{ borderColor: 'var(--bg-tertiary)' }}
            >
              <div
                className="flex items-center gap-4 transition-colors"
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Avatar (click → profile) */}
                <button
                  type="button"
                  onClick={() => onNavigateToProfile?.(user.userId)}
                  className="w-12 h-12 rounded-full flex items-center justify-center text-lg shrink-0 hover:opacity-80"
                  style={{
                    background: isAgent ? 'var(--agent-bg)' : 'var(--bg-tertiary)',
                    border: isAgent ? '1px solid var(--accent)' : 'none',
                  }}
                  aria-label={`View ${user.displayName}'s profile`}
                >
                  {isAgent ? '🪰' : user.displayName?.charAt(0)?.toUpperCase() || '?'}
                </button>

                {/* Info (name click → profile) */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onNavigateToProfile?.(user.userId)}
                      className="font-medium text-sm hover:underline truncate"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {user.displayName}
                    </button>
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
                    type="button"
                    onClick={() => handleMessage(user)}
                    disabled={isOpening}
                    className="px-4 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
                    style={{ background: 'var(--accent)', color: 'white' }}
                  >
                    {isOpening ? 'Opening…' : '💬 Message'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFollow(user)}
                    className="px-4 py-2 rounded-lg text-xs font-medium"
                    style={{
                      background: isFollowing ? 'var(--accent)' : 'var(--bg-tertiary)',
                      color: isFollowing ? 'white' : 'var(--text-primary)',
                    }}
                  >
                    {isFollowing ? '✓ Following' : '+ Follow'}
                  </button>
                </div>
              </div>
              {error && (
                <p role="alert" className="text-xs mt-2 ml-16" style={{ color: 'var(--danger)' }}>{error}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
