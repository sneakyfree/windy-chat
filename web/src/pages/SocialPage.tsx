import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';

interface Post {
  id: string;
  userId: string;
  displayName?: string | null;
  chatUserId?: string | null;
  content: string;
  createdAt: string;
  likeCount: number;
  verified?: boolean;
  visibility?: string;
  repostOf?: string;
  mediaIds?: string[];
}

interface TrendingTag {
  tag: string;
  postCount: number;
}

export default function SocialPage({
  userId: _userId,
  onNavigateToChat,
  onNavigateToProfile,
}: {
  userId: string | null;
  onNavigateToChat?: () => void;
  onNavigateToProfile?: (userId: string) => void;
}) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [trending, setTrending] = useState<TrendingTag[]>([]);
  const [newPost, setNewPost] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [tab, setTab] = useState<'feed' | 'trending'>('feed');

  const [feedError, setFeedError] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
    try {
      setFeedError(null);
      const data = await api.getFeed();
      setPosts(data.posts || []);
    } catch {
      setFeedError('Social feed unavailable — check your connection and try again');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTrending = useCallback(async () => {
    try {
      const data = await api.getTrending();
      setTrending(data.hashtags || data.trending || []);
    } catch (err) {
      console.warn('Trending load failed:', err);
    }
  }, []);

  useEffect(() => {
    loadFeed();
    loadTrending();
  }, [loadFeed, loadTrending]);

  const handlePost = async () => {
    if (!newPost.trim()) return;
    setPosting(true);
    try {
      await api.createPost(newPost.trim());
      setNewPost('');
      loadFeed();
    } catch (err) {
      console.error('Post failed:', err);
    } finally {
      setPosting(false);
    }
  };

  const handleLike = async (postId: string) => {
    try {
      await api.likePost(postId);
      setPosts(ps => ps.map(p => p.id === postId ? { ...p, likeCount: p.likeCount + 1 } : p));
    } catch { /* ignore */ }
  };

  const timeAgo = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  // Absolute timestamp for hover tooltip — full locale-aware date/time.
  // Posts that disappear behind "just now" or "2h" still expose their
  // absolute creation moment without forcing the user to mouse-hover-and-wait.
  const fullTimestamp = (iso: string) => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    } catch {
      return iso;
    }
  };

  // Author name to display: prefer the snapshot, fall back to handle, then
  // last-resort to the raw user_id. The grandma-demo bug was raw-UUID rendering.
  const authorName = (p: Post) =>
    (p.displayName && p.displayName.trim()) ||
    (p.chatUserId && p.chatUserId.trim()) ||
    p.userId;

  // First-letter avatar — prefer display name initial over UUID char.
  const avatarChar = (p: Post) => {
    if (p.userId.startsWith('bot_') || p.userId.startsWith('agent_')) return '🪰';
    return authorName(p).charAt(0).toUpperCase();
  };

  return (
    <div className="flex h-screen" style={{ background: 'var(--bg-primary)' }}>
      {/* Main Feed */}
      <div className="flex-1 max-w-2xl mx-auto">
        {/* Tab Bar */}
        <div className="flex border-b sticky top-0 z-10"
             style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-primary)' }}>
          <button
            onClick={() => setTab('feed')}
            className="flex-1 py-4 text-sm font-medium transition-colors"
            style={{
              color: tab === 'feed' ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: tab === 'feed' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            Feed
          </button>
          <button
            onClick={() => setTab('trending')}
            className="flex-1 py-4 text-sm font-medium transition-colors"
            style={{
              color: tab === 'trending' ? 'var(--accent)' : 'var(--text-secondary)',
              borderBottom: tab === 'trending' ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            Trending
          </button>
        </div>

        {tab === 'feed' && (
          <>
            {/* Compose Box */}
            <div className="p-4 border-b" style={{ borderColor: 'var(--bg-tertiary)' }}>
              <textarea
                placeholder="What's on your mind?"
                value={newPost}
                onChange={e => setNewPost(e.target.value)}
                rows={3}
                className="w-full px-4 py-3 rounded-xl text-sm outline-none resize-none"
                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
              />
              <div className="flex justify-between items-center mt-3">
                <span className="text-xs" style={{ color: newPost.length > 4500 ? 'var(--danger)' : 'var(--text-muted)' }}>
                  {newPost.length}/5000
                </span>
                <button
                  onClick={handlePost}
                  disabled={!newPost.trim() || posting}
                  className="px-6 py-2 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                  style={{ background: 'var(--accent)', color: 'white' }}
                >
                  {posting ? 'Posting...' : 'Post'}
                </button>
              </div>
            </div>

            {/* Posts */}
            <div>
              {feedError ? (
                <div className="text-center py-12">
                  <div className="text-3xl mb-3">⚠️</div>
                  <p className="text-sm mb-4" style={{ color: 'var(--text-muted)' }}>{feedError}</p>
                  <button onClick={loadFeed} className="px-4 py-2 rounded-xl text-sm" style={{ background: 'var(--accent)', color: 'white' }}>Retry</button>
                </div>
              ) : loading ? (
                <div className="text-center py-12" style={{ color: 'var(--text-muted)' }}>Loading...</div>
              ) : posts.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-3xl mb-3">📝</div>
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No posts yet. Follow people or create your first post!</p>
                </div>
              ) : (
                posts.map(post => (
                  <div key={post.id} className="p-4 border-b transition-colors"
                       style={{ borderColor: 'var(--bg-tertiary)' }}
                       onMouseEnter={e => (e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)'}
                       onMouseLeave={e => (e.currentTarget as HTMLDivElement).style.background = 'transparent'}>

                    <div className="flex items-start gap-3">
                      {/* Avatar — clickable, opens the author's profile */}
                      <button
                        type="button"
                        onClick={() => onNavigateToProfile?.(post.userId)}
                        aria-label={`View ${authorName(post)}'s profile`}
                        className="w-10 h-10 rounded-full flex items-center justify-center text-sm shrink-0 hover:opacity-80 transition-opacity"
                        style={{ background: post.verified ? 'var(--agent-bg)' : 'var(--bg-tertiary)', cursor: onNavigateToProfile ? 'pointer' : 'default' }}
                      >
                        {avatarChar(post)}
                      </button>

                      <div className="flex-1 min-w-0">
                        {/* Author */}
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <button
                            type="button"
                            onClick={() => onNavigateToProfile?.(post.userId)}
                            className="font-medium text-sm hover:underline truncate"
                            style={{ color: 'var(--text-primary)', cursor: onNavigateToProfile ? 'pointer' : 'default' }}
                          >
                            {authorName(post)}
                          </button>
                          {post.chatUserId && (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                              @{post.chatUserId}
                            </span>
                          )}
                          {post.verified && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                              ✓ Verified
                            </span>
                          )}
                          {post.repostOf && (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>reposted</span>
                          )}
                          <span
                            className="text-xs"
                            style={{ color: 'var(--text-muted)' }}
                            title={fullTimestamp(post.createdAt)}
                          >
                            · {timeAgo(post.createdAt)}
                          </span>
                        </div>

                        {/* Content */}
                        <p className="text-sm whitespace-pre-wrap break-words mb-3" style={{ color: 'var(--text-primary)' }}>
                          {post.content.split(/(#\w+)/g).map((part, i) =>
                            part.startsWith('#') ? (
                              <span key={i} style={{ color: 'var(--accent)' }}>{part}</span>
                            ) : part
                          )}
                        </p>

                        {/* Actions */}
                        <div className="flex items-center gap-6">
                          <button
                            onClick={() => handleLike(post.id)}
                            className="flex items-center gap-1.5 text-xs transition-colors"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            ♥ {post.likeCount || 0}
                          </button>
                          <button className="text-xs" style={{ color: 'var(--text-secondary)' }}>💬 Comment</button>
                          <button className="text-xs" style={{ color: 'var(--text-secondary)' }}>↗ Share</button>
                          {/* Agent marketplace: "Chat Now" for agent posts */}
                          {(post.userId.startsWith('bot_') || post.verified) && onNavigateToChat && (
                            <button
                              onClick={() => onNavigateToChat()}
                              className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ml-auto"
                              style={{ background: 'var(--accent)', color: 'white' }}
                            >
                              🪰 Chat Now
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {tab === 'trending' && (
          <div className="p-4">
            <h3 className="text-lg font-medium mb-4" style={{ color: 'var(--text-primary)' }}>Trending Now</h3>
            {trending.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No trending topics yet</p>
            ) : (
              trending.map((tag, i) => (
                <div key={tag.tag} className="flex items-center gap-4 py-3 border-b"
                     style={{ borderColor: 'var(--bg-tertiary)' }}>
                  <span className="text-lg font-bold w-8 text-right" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                  <div className="flex-1">
                    <span className="font-medium" style={{ color: 'var(--accent)' }}>#{tag.tag}</span>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {tag.postCount} post{tag.postCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
