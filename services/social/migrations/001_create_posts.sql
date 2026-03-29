-- Windy Chat — Social Service Migration 001
-- K10: Posts, follows, notifications, reports, verified accounts, likes
-- Target: PostgreSQL 16 (shared instance from docker-compose.yml)
--
-- Run when shared DB migration lands (Phase 0 hardening).

BEGIN;

-- ── Posts ──
CREATE TABLE IF NOT EXISTS social_posts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  content       TEXT NOT NULL CHECK (char_length(content) <= 5000),
  translated_versions JSONB DEFAULT NULL,
  like_count    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_posts_user_id ON social_posts (user_id);
CREATE INDEX idx_posts_created_at ON social_posts (created_at DESC);
CREATE INDEX idx_posts_user_created ON social_posts (user_id, created_at DESC);

-- ── Follows ──
CREATE TABLE IF NOT EXISTS social_follows (
  follower_id   TEXT NOT NULL,
  followed_id   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id)
);

CREATE INDEX idx_follows_followed ON social_follows (followed_id);
CREATE INDEX idx_follows_follower ON social_follows (follower_id);

-- ── Likes ──
CREATE TABLE IF NOT EXISTS social_likes (
  user_id       TEXT NOT NULL,
  post_id       UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);

CREATE INDEX idx_likes_post_id ON social_likes (post_id);

-- ── Notifications ──
CREATE TABLE IF NOT EXISTS social_notifications (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('follow', 'like')),
  from_user_id  TEXT NOT NULL,
  post_id       UUID REFERENCES social_posts(id) ON DELETE CASCADE,
  read          BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user ON social_notifications (user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON social_notifications (user_id) WHERE read = false;

-- ── Reports ──
CREATE TABLE IF NOT EXISTS social_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id         UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  post_author_id  TEXT NOT NULL,
  reported_by     TEXT NOT NULL,
  reason          TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate_speech', 'violence', 'nudity', 'misinformation', 'other')),
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, reported_by)
);

CREATE INDEX idx_reports_status ON social_reports (status) WHERE status = 'pending';
CREATE INDEX idx_reports_post ON social_reports (post_id);

-- ── Eternitas Verified Accounts ──
CREATE TABLE IF NOT EXISTS social_verified_accounts (
  user_id       TEXT PRIMARY KEY,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger to keep like_count in sync
CREATE OR REPLACE FUNCTION update_post_like_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE social_posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE social_posts SET like_count = like_count - 1 WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_like_count
AFTER INSERT OR DELETE ON social_likes
FOR EACH ROW EXECUTE FUNCTION update_post_like_count();

COMMIT;
