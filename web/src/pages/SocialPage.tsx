import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../lib/api';

interface PendingMedia {
  media_id: string;
  url: string;
  thumbnail_url: string | null;
  mime_type: string;
  original_name: string;
  // Local-only preview while the upload is still in flight
  previewUrl?: string;
  uploading?: boolean;
}

const MAX_ATTACHMENTS = 4;
// 25 MB cap matches the server's multer limit; checked client-side for
// fast feedback before we bother uploading.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * Render a single comment row — used for both top-level comments and nested
 * replies. The `compact` variant shrinks the avatar so reply chains don't
 * waste horizontal space.
 */
function CommentRowView({
  c, post, onLike, onReply, onAuthorClick, authorName, avatarChar, timeAgo, fullTime, compact,
  replyingToAuthor,
}: {
  c: CommentRow;
  post: Post;
  onLike: () => void;
  onReply: () => void;
  onAuthorClick: () => void;
  authorName: string;
  avatarChar: string;
  timeAgo: string;
  fullTime: string;
  compact?: boolean;
  replyingToAuthor?: string | null;
}) {
  const isAuthor = c.userId === post.userId;
  const avatarSize = compact ? 'w-6 h-6' : 'w-7 h-7';
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={onAuthorClick}
        aria-label={`View ${authorName}'s profile`}
        className={`${avatarSize} rounded-full flex items-center justify-center text-xs shrink-0 hover:opacity-80`}
        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
      >
        {avatarChar}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onAuthorClick}
            className="text-xs font-medium hover:underline truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {authorName}
          </button>
          {c.chatUserId && (
            <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>@{c.chatUserId}</span>
          )}
          {isAuthor && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>
              author
            </span>
          )}
          <span
            className="text-[10px]"
            style={{ color: 'var(--text-muted)' }}
            title={fullTime}
          >
            · {timeAgo}
          </span>
        </div>
        {replyingToAuthor && (
          <p className="text-[10px] mb-0.5" style={{ color: 'var(--text-muted)' }}>
            ↩ to <span style={{ color: 'var(--text-secondary)' }}>{replyingToAuthor}</span>
          </p>
        )}
        <p className="text-xs whitespace-pre-wrap break-words" style={{ color: 'var(--text-primary)' }}>
          {c.content}
        </p>
        <div className="flex items-center gap-4 mt-1">
          <button
            type="button"
            onClick={onLike}
            aria-pressed={!!c.liked}
            aria-label={c.liked ? 'Unlike comment' : 'Like comment'}
            className="flex items-center gap-1 text-[11px]"
            style={{ color: c.liked ? 'var(--danger)' : 'var(--text-secondary)' }}
          >
            {c.liked ? '♥' : '♡'} {c.likeCount || 0}
          </button>
          {/* Reply is allowed at every depth. The new reply attaches to THIS
              comment (parent_comment_id = c.id); the renderer keeps the
              visual indent at 1 level beyond the top — the "↩ to <author>"
              line above shows who's actually being replied to so deep
              threads stay legible without runaway indentation. */}
          <button
            type="button"
            onClick={onReply}
            className="text-[11px]"
            style={{ color: 'var(--text-secondary)' }}
          >
            ↩ Reply
          </button>
        </div>
      </div>
    </div>
  );
}

interface Post {
  id: string;
  userId: string;
  displayName?: string | null;
  chatUserId?: string | null;
  content: string;
  createdAt: string;
  likeCount: number;
  liked?: boolean;
  commentCount?: number;
  verified?: boolean;
  visibility?: string;
  repostOf?: string;
  mediaIds?: string[];
}

interface CommentRow {
  id: string;
  postId: string;
  userId: string;
  displayName?: string | null;
  chatUserId?: string | null;
  parentCommentId?: string | null;
  likeCount?: number;
  liked?: boolean;
  content: string;
  createdAt: string;
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
  // When non-null, the feed renders /hashtag/:tag results instead of the
  // follow-feed. A "Back to feed" pill lets the user return.
  const [activeHashtag, setActiveHashtag] = useState<string | null>(null);
  const [newPost, setNewPost] = useState('');
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [tab, setTab] = useState<'feed' | 'trending'>('feed');

  // Comments UI state — keyed by postId. When a post's id is in
  // openComments, its inline comment thread is expanded; we cache the
  // fetched comments + the draft input + a posting flag per post.
  const [openComments, setOpenComments] = useState<Record<string, boolean>>({});
  const [commentsByPost, setCommentsByPost] = useState<Record<string, CommentRow[]>>({});
  const [commentDraft, setCommentDraft] = useState<Record<string, string>>({});
  const [commentSubmitting, setCommentSubmitting] = useState<Record<string, boolean>>({});
  const [commentsLoading, setCommentsLoading] = useState<Record<string, boolean>>({});
  const [replyingTo, setReplyingTo] = useState<Record<string, string | null>>({});
  const [shareToast, setShareToast] = useState<string | null>(null);

  const [feedError, setFeedError] = useState<string | null>(null);

  const loadFeed = useCallback(async () => {
    try {
      setFeedError(null);
      // If a hashtag filter is active, fetch that view instead of the
      // chronological follow-feed. Switching back to the regular feed
      // re-fires loadFeed via the activeHashtag effect below.
      const data = activeHashtag
        ? await api.getPostsByHashtag(activeHashtag)
        : await api.getFeed();
      setPosts(data.posts || []);
    } catch {
      setFeedError('Social feed unavailable — check your connection and try again');
    } finally {
      setLoading(false);
    }
  }, [activeHashtag]);

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
    // Block while uploads are still in flight — posting before they finish
    // would create a post with dangling/missing media_ids.
    const uploading = pendingMedia.some(m => m.uploading);
    if (uploading) return;
    if (!newPost.trim() && pendingMedia.length === 0) return;
    setPosting(true);
    try {
      const mediaIds = pendingMedia
        .filter(m => !m.uploading && m.media_id)
        .map(m => m.media_id);
      await api.createPost(newPost.trim(), mediaIds.length > 0 ? { media_ids: mediaIds } : undefined);
      // Release any blob: URLs we created for previews so they don't leak
      pendingMedia.forEach(m => { if (m.previewUrl) URL.revokeObjectURL(m.previewUrl); });
      setNewPost('');
      setPendingMedia([]);
      setMediaError(null);
      loadFeed();
    } catch (err) {
      console.error('Post failed:', err);
    } finally {
      setPosting(false);
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setMediaError(null);

    const room = MAX_ATTACHMENTS - pendingMedia.length;
    if (room <= 0) {
      setMediaError(`You can attach at most ${MAX_ATTACHMENTS} files per post.`);
      return;
    }

    const toAdd = Array.from(files).slice(0, room);

    // Insert placeholder entries with optimistic previews so the user sees
    // the attachments immediately, even before the upload completes.
    const optimistic: PendingMedia[] = toAdd.map((f, i) => ({
      media_id: `pending_${Date.now()}_${i}`,
      url: '',
      thumbnail_url: null,
      mime_type: f.type,
      original_name: f.name,
      previewUrl: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined,
      uploading: true,
    }));
    setPendingMedia(prev => [...prev, ...optimistic]);

    // Upload sequentially — keeps the bandwidth predictable and avoids a
    // burst that could trip rate limits on slow connections.
    for (let i = 0; i < toAdd.length; i++) {
      const file = toAdd[i];
      const placeholderId = optimistic[i].media_id;
      if (file.size > MAX_FILE_BYTES) {
        setMediaError(`"${file.name}" is larger than 25 MB.`);
        setPendingMedia(prev => prev.filter(m => m.media_id !== placeholderId));
        continue;
      }
      try {
        const result = await api.uploadMedia(file);
        setPendingMedia(prev => prev.map(m =>
          m.media_id === placeholderId
            ? {
                media_id: result.media_id,
                url: result.url,
                thumbnail_url: result.thumbnail_url,
                mime_type: result.mime_type,
                original_name: result.original_name,
                previewUrl: optimistic[i].previewUrl,
                uploading: false,
              }
            : m,
        ));
      } catch (err) {
        console.warn('[media] upload failed', err);
        setMediaError(`Upload failed for "${file.name}".`);
        setPendingMedia(prev => prev.filter(m => m.media_id !== placeholderId));
      }
    }

    // Allow re-selecting the same file in the same composer session.
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removePendingMedia = (mediaId: string) => {
    setPendingMedia(prev => {
      const target = prev.find(m => m.media_id === mediaId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter(m => m.media_id !== mediaId);
    });
  };

  // Like is a toggle. We optimistically flip `liked` + adjust `likeCount`
  // by ±1, then send POST or DELETE based on the BEFORE state. If the
  // server rejects, we revert. The frontend used to call POST on every
  // click and increment unconditionally, which is why Grant could see
  // "30" after 30 clicks even though the server (Set-backed) only
  // recorded 1 like.
  const handleLike = async (postId: string) => {
    let wasLiked = false;
    setPosts(ps => ps.map(p => {
      if (p.id !== postId) return p;
      wasLiked = !!p.liked;
      return {
        ...p,
        liked: !wasLiked,
        likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? -1 : 1)),
      };
    }));
    try {
      const result = wasLiked
        ? await api.unlikePost(postId)
        : await api.likePost(postId);
      // If the server returned an authoritative count, sync to it.
      if (typeof result?.likeCount === 'number') {
        setPosts(ps => ps.map(p => p.id === postId
          ? { ...p, liked: !!result.liked, likeCount: result.likeCount }
          : p));
      }
    } catch {
      // Revert the optimistic update on failure.
      setPosts(ps => ps.map(p => p.id === postId
        ? { ...p, liked: wasLiked, likeCount: Math.max(0, (p.likeCount || 0) + (wasLiked ? 1 : -1)) }
        : p));
    }
  };

  const toggleComments = async (postId: string) => {
    const isOpen = !!openComments[postId];
    setOpenComments(s => ({ ...s, [postId]: !isOpen }));
    if (isOpen) return;
    // Only fetch the first time the thread is opened.
    if (commentsByPost[postId]) return;
    setCommentsLoading(s => ({ ...s, [postId]: true }));
    try {
      const data = await api.getComments(postId);
      setCommentsByPost(s => ({ ...s, [postId]: data.comments || [] }));
    } catch (err) {
      console.warn('[social] load comments failed', err);
    } finally {
      setCommentsLoading(s => ({ ...s, [postId]: false }));
    }
  };

  const submitComment = async (postId: string) => {
    const draft = (commentDraft[postId] || '').trim();
    if (!draft || commentSubmitting[postId]) return;
    setCommentSubmitting(s => ({ ...s, [postId]: true }));
    try {
      const parentCommentId = replyingTo[postId] || null;
      const created = await api.createComment(postId, draft, { parentCommentId });
      setCommentsByPost(s => ({
        ...s,
        [postId]: [...(s[postId] || []), created as CommentRow],
      }));
      setCommentDraft(s => ({ ...s, [postId]: '' }));
      setReplyingTo(s => ({ ...s, [postId]: null }));
      setPosts(ps => ps.map(p => p.id === postId
        ? { ...p, commentCount: (p.commentCount || 0) + 1 }
        : p));
    } catch (err) {
      console.warn('[social] create comment failed', err);
    } finally {
      setCommentSubmitting(s => ({ ...s, [postId]: false }));
    }
  };

  // Toggle like on a single comment. Same pattern as post-like: optimistic
  // flip + ±1, POST or DELETE based on prior state, revert on error.
  const handleCommentLike = async (postId: string, commentId: string) => {
    let wasLiked = false;
    setCommentsByPost(s => ({
      ...s,
      [postId]: (s[postId] || []).map(c => {
        if (c.id !== commentId) return c;
        wasLiked = !!c.liked;
        return { ...c, liked: !wasLiked, likeCount: Math.max(0, (c.likeCount || 0) + (wasLiked ? -1 : 1)) };
      }),
    }));
    try {
      const result = wasLiked
        ? await api.unlikeComment(postId, commentId)
        : await api.likeComment(postId, commentId);
      setCommentsByPost(s => ({
        ...s,
        [postId]: (s[postId] || []).map(c => c.id === commentId
          ? { ...c, liked: !!result.liked, likeCount: result.likeCount }
          : c),
      }));
    } catch {
      setCommentsByPost(s => ({
        ...s,
        [postId]: (s[postId] || []).map(c => c.id === commentId
          ? { ...c, liked: wasLiked, likeCount: Math.max(0, (c.likeCount || 0) + (wasLiked ? 1 : -1)) }
          : c),
      }));
    }
  };

  const startReply = (postId: string, commentId: string) => {
    setReplyingTo(s => ({ ...s, [postId]: commentId }));
    // Bring focus + nudge user toward the composer at the bottom of the
    // thread by pre-filling a mention. Empty draft would also be fine.
    setCommentDraft(s => ({ ...s, [postId]: s[postId] || '' }));
  };

  const cancelReply = (postId: string) => {
    setReplyingTo(s => ({ ...s, [postId]: null }));
  };

  const commentAuthorName = (c: CommentRow) =>
    (c.displayName && c.displayName.trim()) ||
    (c.chatUserId && c.chatUserId.trim()) ||
    c.userId;
  const commentAvatarChar = (c: CommentRow) =>
    (c.userId.startsWith('bot_') || c.userId.startsWith('agent_'))
      ? '🪰'
      : commentAuthorName(c).charAt(0).toUpperCase();

  const handleShare = async (post: Post) => {
    // We don't have a true "post detail" URL yet — the feed is the only
    // surface — so we share the social tab + the post id as a query
    // parameter. Future post-detail routing can read this back.
    const url = `${window.location.origin}/?post=${encodeURIComponent(post.id)}`;
    const shareText = (post.content || '').slice(0, 140);
    try {
      if (navigator.share) {
        await navigator.share({ title: 'Windy Chat post', text: shareText, url });
        return;
      }
    } catch {
      // User cancelled the native sheet — fall through to clipboard.
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareToast('Link copied to clipboard');
      setTimeout(() => setShareToast(null), 2000);
    } catch {
      setShareToast('Could not copy link — copy from your browser bar');
      setTimeout(() => setShareToast(null), 2500);
    }
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
    <div className="flex h-screen relative" style={{ background: 'var(--bg-primary)' }}>
      {/* Share toast */}
      {shareToast && (
        <div
          role="status"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 px-4 py-2 rounded-full text-sm shadow-lg z-50"
          style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
        >
          {shareToast}
        </div>
      )}

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
            {/* Active hashtag filter pill */}
            {activeHashtag && (
              <div
                className="flex items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}
              >
                <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
                  Filtering by <span style={{ color: 'var(--accent)' }}>#{activeHashtag}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setActiveHashtag(null)}
                  className="text-xs underline"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  ← Back to feed
                </button>
              </div>
            )}
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

              {/* Pending attachments preview row */}
              {pendingMedia.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {pendingMedia.map(m => {
                    const isImage = m.mime_type.startsWith('image/') || !!m.previewUrl;
                    return (
                      <div
                        key={m.media_id}
                        className="relative rounded-lg overflow-hidden border"
                        style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}
                      >
                        {isImage && (m.previewUrl || m.thumbnail_url) ? (
                          <img
                            src={m.previewUrl || (m.thumbnail_url ? `${m.thumbnail_url}` : '')}
                            alt={m.original_name}
                            className="block w-24 h-24 object-cover"
                            style={{ opacity: m.uploading ? 0.5 : 1 }}
                          />
                        ) : (
                          <div
                            className="w-24 h-24 flex flex-col items-center justify-center px-1 text-center"
                            style={{ opacity: m.uploading ? 0.5 : 1 }}
                          >
                            <div className="text-2xl">📎</div>
                            <div
                              className="text-[10px] leading-tight mt-1 break-all line-clamp-2"
                              style={{ color: 'var(--text-secondary)' }}
                            >
                              {m.original_name}
                            </div>
                          </div>
                        )}
                        {m.uploading && (
                          <div className="absolute inset-0 flex items-center justify-center text-[10px]"
                               style={{ background: 'rgba(0,0,0,0.35)', color: 'white' }}>
                            Uploading…
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => removePendingMedia(m.media_id)}
                          aria-label={`Remove ${m.original_name}`}
                          className="absolute top-1 right-1 w-5 h-5 rounded-full flex items-center justify-center text-[11px]"
                          style={{ background: 'rgba(0,0,0,0.6)', color: 'white' }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {mediaError && (
                <p role="alert" className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
                  {mediaError}
                </p>
              )}

              <div className="flex justify-between items-center mt-3">
                <div className="flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,video/*,audio/*,.pdf,.txt,.md,.zip"
                    onChange={e => handleFiles(e.target.files)}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={pendingMedia.length >= MAX_ATTACHMENTS}
                    aria-label="Attach files"
                    title={pendingMedia.length >= MAX_ATTACHMENTS
                      ? `Up to ${MAX_ATTACHMENTS} attachments per post`
                      : 'Attach images or files'}
                    className="text-base px-2 py-1 rounded-lg transition-colors disabled:opacity-40"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    📎
                  </button>
                  <span className="text-xs" style={{ color: newPost.length > 4500 ? 'var(--danger)' : 'var(--text-muted)' }}>
                    {newPost.length}/5000
                  </span>
                </div>
                <button
                  onClick={handlePost}
                  disabled={(!newPost.trim() && pendingMedia.length === 0) || posting || pendingMedia.some(m => m.uploading)}
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
                              <button
                                key={i}
                                type="button"
                                onClick={() => { setTab('feed'); setActiveHashtag(part.slice(1)); }}
                                className="hover:underline"
                                style={{ color: 'var(--accent)', cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
                              >
                                {part}
                              </button>
                            ) : part,
                          )}
                        </p>

                        {/* Attached media */}
                        {post.mediaIds && post.mediaIds.length > 0 && (
                          <div className={`mb-3 grid gap-2 ${post.mediaIds.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                            {post.mediaIds.map(mid => (
                              <a
                                key={mid}
                                href={api.mediaUrlFor(mid)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block rounded-xl overflow-hidden border"
                                style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}
                              >
                                <img
                                  src={api.mediaThumbnailUrlFor(mid)}
                                  alt="attachment"
                                  onError={e => {
                                    // Non-image attachment: swap to a generic "open file" tile.
                                    const target = e.currentTarget as HTMLImageElement;
                                    target.style.display = 'none';
                                    const sib = target.nextElementSibling as HTMLElement | null;
                                    if (sib) sib.style.display = 'flex';
                                  }}
                                  className="block w-full max-h-96 object-cover"
                                />
                                <div
                                  className="hidden p-4 items-center gap-2 text-sm"
                                  style={{ color: 'var(--text-secondary)' }}
                                >
                                  📎 <span className="underline">Open attachment</span>
                                </div>
                              </a>
                            ))}
                          </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-6">
                          <button
                            type="button"
                            onClick={() => handleLike(post.id)}
                            aria-pressed={!!post.liked}
                            aria-label={post.liked ? 'Unlike' : 'Like'}
                            className="flex items-center gap-1.5 text-xs transition-colors"
                            style={{ color: post.liked ? 'var(--danger)' : 'var(--text-secondary)' }}
                          >
                            {post.liked ? '♥' : '♡'} {post.likeCount || 0}
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleComments(post.id)}
                            aria-expanded={!!openComments[post.id]}
                            className="flex items-center gap-1.5 text-xs"
                            style={{ color: openComments[post.id] ? 'var(--accent)' : 'var(--text-secondary)' }}
                          >
                            💬 {post.commentCount ? post.commentCount : 'Comment'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleShare(post)}
                            className="text-xs"
                            style={{ color: 'var(--text-secondary)' }}
                          >
                            ↗ Share
                          </button>
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

                        {/* Inline comments thread */}
                        {openComments[post.id] && (
                          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--bg-tertiary)' }}>
                            {commentsLoading[post.id] ? (
                              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Loading comments…</p>
                            ) : (
                              <div className="space-y-3 mb-3">
                                {(commentsByPost[post.id] || []).filter(c => !c.parentCommentId).length === 0 ? (
                                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No comments yet — be the first.</p>
                                ) : (
                                  // Render top-level comments + every descendant reply
                                  // beneath, flattened (visual indent capped at 1 level so
                                  // deep threads stay readable; the "↩ to <author>" line
                                  // on the row makes the true reply target legible).
                                  (() => {
                                    const all = commentsByPost[post.id] || [];
                                    const byId = new Map(all.map(c => [c.id, c]));
                                    const topLevel = all.filter(c => !c.parentCommentId);
                                    // Collect descendants in pre-order so reply chains read
                                    // in conversation order (parent → child → grandchild).
                                    const collectDescendants = (parentId: string): CommentRow[] => {
                                      const acc: CommentRow[] = [];
                                      const walk = (id: string) => {
                                        for (const c of all) {
                                          if (c.parentCommentId === id) {
                                            acc.push(c);
                                            walk(c.id);
                                          }
                                        }
                                      };
                                      walk(parentId);
                                      return acc;
                                    };
                                    return topLevel.map(c => {
                                      const descendants = collectDescendants(c.id);
                                      return (
                                        <div key={c.id}>
                                          <CommentRowView
                                            c={c}
                                            post={post}
                                            onLike={() => handleCommentLike(post.id, c.id)}
                                            onReply={() => startReply(post.id, c.id)}
                                            onAuthorClick={() => onNavigateToProfile?.(c.userId)}
                                            authorName={commentAuthorName(c)}
                                            avatarChar={commentAvatarChar(c)}
                                            timeAgo={timeAgo(c.createdAt)}
                                            fullTime={fullTimestamp(c.createdAt)}
                                          />
                                          {descendants.length > 0 && (
                                            <div className="ml-9 mt-3 space-y-3 border-l pl-3" style={{ borderColor: 'var(--bg-tertiary)' }}>
                                              {descendants.map(r => {
                                                const parent = r.parentCommentId ? byId.get(r.parentCommentId) : null;
                                                const replyingToAuthor = parent && parent.id !== c.id
                                                  ? commentAuthorName(parent)
                                                  : null;
                                                return (
                                                  <CommentRowView
                                                    key={r.id}
                                                    c={r}
                                                    post={post}
                                                    onLike={() => handleCommentLike(post.id, r.id)}
                                                    onReply={() => startReply(post.id, r.id) /* reply to THIS reply */}
                                                    onAuthorClick={() => onNavigateToProfile?.(r.userId)}
                                                    authorName={commentAuthorName(r)}
                                                    avatarChar={commentAvatarChar(r)}
                                                    timeAgo={timeAgo(r.createdAt)}
                                                    fullTime={fullTimestamp(r.createdAt)}
                                                    compact
                                                    replyingToAuthor={replyingToAuthor}
                                                  />
                                                );
                                              })}
                                            </div>
                                          )}
                                        </div>
                                      );
                                    });
                                  })()
                                )}
                              </div>
                            )}
                            {replyingTo[post.id] && (
                              <div className="text-[11px] mb-2 flex items-center justify-between" style={{ color: 'var(--text-muted)' }}>
                                <span>Replying to a comment</span>
                                <button
                                  type="button"
                                  onClick={() => cancelReply(post.id)}
                                  className="underline"
                                  style={{ color: 'var(--text-muted)' }}
                                >
                                  cancel
                                </button>
                              </div>
                            )}
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder={replyingTo[post.id] ? 'Write a reply…' : 'Write a comment…'}
                                value={commentDraft[post.id] || ''}
                                onChange={e => setCommentDraft(s => ({ ...s, [post.id]: e.target.value }))}
                                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitComment(post.id); } }}
                                maxLength={2000}
                                className="flex-1 px-3 py-2 rounded-lg text-xs outline-none"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                              />
                              <button
                                type="button"
                                onClick={() => submitComment(post.id)}
                                disabled={!((commentDraft[post.id] || '').trim()) || commentSubmitting[post.id]}
                                className="px-3 py-2 rounded-lg text-xs font-medium disabled:opacity-40"
                                style={{ background: 'var(--accent)', color: 'white' }}
                              >
                                {commentSubmitting[post.id] ? '…' : (replyingTo[post.id] ? 'Reply' : 'Post')}
                              </button>
                            </div>
                          </div>
                        )}
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
                <button
                  key={tag.tag}
                  type="button"
                  onClick={() => { setTab('feed'); setActiveHashtag(tag.tag); }}
                  className="w-full flex items-center gap-4 py-3 border-b text-left transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--bg-tertiary)' }}
                >
                  <span className="text-lg font-bold w-8 text-right" style={{ color: 'var(--text-muted)' }}>{i + 1}</span>
                  <div className="flex-1">
                    <span className="font-medium" style={{ color: 'var(--accent)' }}>#{tag.tag}</span>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                      {tag.postCount} post{tag.postCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
