import { useState, useEffect, useCallback } from 'react';
import * as api from '../lib/api';

interface Post {
  id: string;
  userId: string;
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

export default function SocialPage({ userId: _userId, onNavigateToChat }: { userId: string | null; onNavigateToChat?: () => void }) {
  const [posts, setPosts] = useState<Post[]>([]);
  const [trending, setTrending] = useState<TrendingTag[]>([]);
  const [newPost, setNewPost] = useState('');
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [tab, setTab] = useState<'feed' | 'trending'>('feed');

  const loadFeed = useCallback(async () => {
    try {
      const data = await api.getFeed();
      setPosts(data.posts || []);
    } catch (err) {
      console.warn('Feed load failed:', err);
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
              {loading ? (
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
                      {/* Avatar */}
                      <div className="w-10 h-10 rounded-full flex items-center justify-center text-sm shrink-0"
                           style={{ background: post.verified ? 'var(--agent-bg)' : 'var(--bg-tertiary)' }}>
                        {post.userId.startsWith('bot_') ? '🪰' : post.userId.charAt(0).toUpperCase()}
                      </div>

                      <div className="flex-1 min-w-0">
                        {/* Author */}
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
                            {post.userId}
                          </span>
                          {post.verified && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--accent)', color: 'white' }}>
                              ✓ Verified
                            </span>
                          )}
                          {post.repostOf && (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>reposted</span>
                          )}
                          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{timeAgo(post.createdAt)}</span>
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
