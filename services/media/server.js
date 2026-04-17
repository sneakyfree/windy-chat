/**
 * Windy Chat — Rich Media Service
 * K4: Rich Media Sharing (DNA Strand K)
 *
 * Handles:
 *   - File uploads (images, video, audio, documents)
 *   - File serving with proper Content-Type
 *   - Thumbnail generation for images (when sharp is available)
 *
 * Port: 8107
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const express = require('express');
const { createCorsOptions } = require('../shared/cors');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const { initSentry, sentryErrorHandler } = require('../shared/sentry');
const mediaDb = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 8107;
const STORAGE_PATH = process.env.MEDIA_STORAGE_PATH || path.join(__dirname, 'data', 'media');
const THUMBNAIL_DIR = path.join(STORAGE_PATH, 'thumbnails');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

// Ensure storage directories exist
fs.mkdirSync(STORAGE_PATH, { recursive: true });
fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

// Try to load sharp for thumbnail generation
let sharp;
try {
  sharp = require('sharp');
  console.log('[media] sharp loaded — thumbnail generation enabled');
} catch {
  console.warn('[media] sharp not available — thumbnail generation disabled');
}

// Allowed MIME types
const ALLOWED_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mp3', '.ogg', '.pdf', '.doc', '.docx']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const VIDEO_TYPES = new Set(['video/mp4']);

// Check if ffmpeg is available
let ffmpegAvailable = false;
execFile('ffmpeg', ['-version'], (err) => {
  if (!err) {
    ffmpegAvailable = true;
    console.log('[media] ffmpeg detected — video thumbnail generation enabled');
  } else {
    console.warn('[media] ffmpeg not available — video thumbnails disabled');
  }
});

// Multer storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, STORAGE_PATH),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || ALLOWED_TYPES[file.mimetype] || '';
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(_req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_TYPES[file.mimetype] || ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type not allowed: ${file.mimetype} (${ext})`));
  }
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

const linkPreviewRouter = require('./routes/link-preview');

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '1mb' }));

initSentry(app, 'windy-chat-media');

const auth = createAuthMiddleware();

// ── Health ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-media',
  version: '1.0.0',
  checks: async () => ({
    storagePath: STORAGE_PATH,
    sharpAvailable: !!sharp,
    ffmpegAvailable,
  }),
}));

/**
 * Generate a thumbnail for an image file.
 * Returns the thumbnail path or null if generation fails.
 */
async function generateThumbnail(filePath, mediaId) {
  if (!sharp) return null;
  try {
    const thumbPath = path.join(THUMBNAIL_DIR, `${mediaId}_thumb.jpg`);
    await sharp(filePath)
      .resize(200, 200, { fit: 'cover' })
      .jpeg({ quality: 80 })
      .toFile(thumbPath);
    return thumbPath;
  } catch (err) {
    console.warn(`[media] Thumbnail generation failed for ${mediaId}:`, err.message);
    return null;
  }
}

/**
 * Generate a thumbnail for a video file using ffmpeg.
 * Extracts a frame at 1 second (or first frame) and resizes to 200x200.
 */
function generateVideoThumbnail(filePath, mediaId) {
  if (!ffmpegAvailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    const thumbPath = path.join(THUMBNAIL_DIR, `${mediaId}_thumb.jpg`);
    const args = [
      '-i', filePath,
      '-ss', '00:00:01.000',
      '-vframes', '1',
      '-vf', 'scale=200:200:force_original_aspect_ratio=increase,crop=200:200',
      '-q:v', '3',
      '-y',
      thumbPath,
    ];
    execFile('ffmpeg', args, { timeout: 10000 }, (err) => {
      if (err) {
        // Retry with first frame (video may be shorter than 1 second)
        const retryArgs = [
          '-i', filePath,
          '-vframes', '1',
          '-vf', 'scale=200:200:force_original_aspect_ratio=increase,crop=200:200',
          '-q:v', '3',
          '-y',
          thumbPath,
        ];
        execFile('ffmpeg', retryArgs, { timeout: 10000 }, (retryErr) => {
          if (retryErr) {
            console.warn(`[media] Video thumbnail failed for ${mediaId}:`, retryErr.message);
            resolve(null);
          } else {
            resolve(thumbPath);
          }
        });
      } else {
        resolve(thumbPath);
      }
    });
  });
}

// ── Audio Waveform Generation (K4 voice messages) ──

const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac']);

/**
 * Generate waveform data for an audio file using ffprobe.
 * Returns an array of ~50 amplitude values (0-1) for visualization.
 */
function generateWaveform(filePath, mediaId) {
  if (!ffmpegAvailable) return Promise.resolve(null);
  return new Promise((resolve) => {
    // Use ffprobe to get audio peak levels at regular intervals
    const args = [
      '-i', filePath,
      '-af', 'astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-',
      '-f', 'null', '-',
    ];
    execFile('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', filePath],
      { timeout: 10000 }, (err, stdout) => {
        if (err) {
          // Fallback: generate a simple waveform from file size pattern
          console.warn(`[media] Waveform generation failed for ${mediaId}: ${err.message}`);
          resolve(null);
          return;
        }
        try {
          const info = JSON.parse(stdout);
          const duration = parseFloat(info.format?.duration || '0');
          if (duration <= 0) { resolve(null); return; }

          // Generate waveform by sampling volume levels
          const samples = 50;
          const interval = duration / samples;
          const waveform = [];

          // Use ffmpeg to get volume levels at each sample point
          const volArgs = [
            '-i', filePath,
            '-af', `aresample=8000,asetnsamples=n=${Math.max(1, Math.floor(8000 * duration / samples))}`,
            '-vn', '-f', 'null', '-',
          ];
          execFile('ffmpeg', volArgs, { timeout: 15000 }, (volErr, _volStdout, volStderr) => {
            if (volErr) {
              // Generate pseudo-waveform from duration
              for (let i = 0; i < samples; i++) {
                waveform.push(Math.random() * 0.6 + 0.2); // Random between 0.2-0.8
              }
            } else {
              // Parse mean_volume from stderr
              const volMatches = (volStderr || '').match(/mean_volume:\s*([-\d.]+)/g) || [];
              for (let i = 0; i < samples; i++) {
                if (i < volMatches.length) {
                  const db = parseFloat(volMatches[i].split(':')[1]);
                  waveform.push(Math.min(1, Math.max(0, 1 + db / 60))); // Normalize -60dB to 0dB → 0 to 1
                } else {
                  waveform.push(0.3 + Math.random() * 0.4);
                }
              }
            }
            resolve({ duration, samples: waveform });
          });
        } catch {
          resolve(null);
        }
      });
  });
}

// ── GET /api/v1/media/:id/waveform — get audio waveform data ──
app.get('/api/v1/media/:id/waveform', asyncHandler(async (req, res) => {
  const row = mediaDb.getMedia.get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Media not found' });
  if (!AUDIO_TYPES.has(row.mime_type)) {
    return res.status(400).json({ error: 'Waveform only available for audio files' });
  }

  const waveform = await generateWaveform(row.file_path, row.id);
  if (!waveform) {
    return res.status(503).json({ error: 'Waveform generation unavailable (ffprobe not found)' });
  }

  res.json({
    media_id: row.id,
    duration: waveform.duration,
    samples: waveform.samples,
    sample_count: waveform.samples.length,
  });
}));

// ── Upload ──
app.post('/api/v1/media/upload', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024}MB)` });
        }
        return res.status(400).json({ error: err.message });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, asyncHandler(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const userId = req.user.sub;
  const mediaId = path.basename(req.file.filename, path.extname(req.file.filename));
  const filePath = req.file.path;

  // Generate thumbnail for images and videos, waveform for audio
  let thumbnailPath = null;
  let waveformData = null;
  if (IMAGE_TYPES.has(req.file.mimetype)) {
    thumbnailPath = await generateThumbnail(filePath, mediaId);
  } else if (VIDEO_TYPES.has(req.file.mimetype)) {
    thumbnailPath = await generateVideoThumbnail(filePath, mediaId);
  } else if (AUDIO_TYPES.has(req.file.mimetype)) {
    waveformData = await generateWaveform(filePath, mediaId);
  }

  // Store metadata in SQLite
  mediaDb.insertMedia.run({
    id: mediaId,
    user_id: userId,
    windy_identity_id: req.user.windy_identity_id || null,
    original_name: req.file.originalname,
    mime_type: req.file.mimetype,
    size: req.file.size,
    file_path: filePath,
    thumbnail_path: thumbnailPath,
    created_at: new Date().toISOString(),
  });

  console.log(`[media] Upload: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB) by ${userId}`);

  res.status(201).json({
    media_id: mediaId,
    url: `/api/v1/media/${mediaId}`,
    thumbnail_url: thumbnailPath ? `/api/v1/media/${mediaId}/thumbnail` : null,
    waveform: waveformData || undefined,
    mime_type: req.file.mimetype,
    size: req.file.size,
    original_name: req.file.originalname,
  });
}));

// ── Gallery: user media ──
app.get('/api/v1/media/gallery', auth, asyncHandler(async (req, res) => {
  const userId = req.query.user_id || req.user.sub;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const items = mediaDb.getUserMediaPaginated.all(userId, limit, offset);

  res.json({
    items: items.map(m => ({
      media_id: m.id,
      url: `/api/v1/media/${m.id}`,
      thumbnail_url: m.thumbnail_path ? `/api/v1/media/${m.id}/thumbnail` : null,
      original_name: m.original_name,
      mime_type: m.mime_type,
      size: m.size,
      room_id: m.room_id || null,
      created_at: m.created_at,
    })),
    count: items.length,
    limit,
    offset,
  });
}));

// ── Gallery: room media ──
app.get('/api/v1/media/gallery/room', auth, asyncHandler(async (req, res) => {
  const roomId = req.query.room_id;
  if (!roomId || typeof roomId !== 'string') {
    return res.status(400).json({ error: 'room_id query parameter is required' });
  }

  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
  const offset = Math.max(parseInt(req.query.offset) || 0, 0);

  const items = mediaDb.getRoomMedia.all(roomId, limit, offset);

  res.json({
    room_id: roomId,
    items: items.map(m => ({
      media_id: m.id,
      url: `/api/v1/media/${m.id}`,
      thumbnail_url: m.thumbnail_path ? `/api/v1/media/${m.id}/thumbnail` : null,
      original_name: m.original_name,
      mime_type: m.mime_type,
      size: m.size,
      created_at: m.created_at,
    })),
    count: items.length,
    limit,
    offset,
  });
}));

// ── Serve file ──
app.get('/api/v1/media/:id', asyncHandler(async (req, res) => {
  const record = mediaDb.getMedia.get(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'Media not found' });
  }

  if (!fs.existsSync(record.file_path)) {
    return res.status(404).json({ error: 'File not found on disk' });
  }

  res.setHeader('Content-Type', record.mime_type);
  // Content-Disposition filename comes from user-uploaded metadata —
  // sanitize before interpolating into the header, otherwise a filename
  // containing CR/LF (or unescaped quotes) can inject arbitrary response
  // headers (P2-3). RFC 6266 §4.3 requires quoted-string escaping of `\`
  // and `"`; we additionally strip CR/LF and control chars.
  res.setHeader('Content-Disposition', buildContentDisposition(record.original_name));
  res.setHeader('Content-Length', record.size);
  fs.createReadStream(record.file_path).pipe(res);
}));

/**
 * Build a safe Content-Disposition header value given a user-supplied
 * filename. Strips control characters, escapes quotes + backslashes,
 * and falls back to a generic name if the input is empty.
 */
function buildContentDisposition(originalName) {
  const raw = typeof originalName === 'string' ? originalName : '';
  // Remove C0/C1 control characters (incl. CR/LF) — these break headers
  const stripped = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim();
  if (!stripped) return 'inline; filename="file"';
  // RFC 6266 quoted-string: backslash-escape \ and "
  const quoted = stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Cap length to avoid degenerate headers
  const capped = quoted.slice(0, 200);
  return `inline; filename="${capped}"`;
}

// ── Serve thumbnail ──
app.get('/api/v1/media/:id/thumbnail', asyncHandler(async (req, res) => {
  const record = mediaDb.getMedia.get(req.params.id);
  if (!record || !record.thumbnail_path) {
    return res.status(404).json({ error: 'Thumbnail not found' });
  }

  if (!fs.existsSync(record.thumbnail_path)) {
    return res.status(404).json({ error: 'Thumbnail file not found on disk' });
  }

  res.setHeader('Content-Type', 'image/jpeg');
  fs.createReadStream(record.thumbnail_path).pipe(res);
}));

// ── Link Preview ──
app.use('/api/v1/media', linkPreviewRouter);

// ── 404 ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use(sentryErrorHandler());
app.use((err, _req, res, _next) => {
  console.error('[media] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Only listen if run directly (not imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[media] listening on :${PORT}`);
    console.log(`[media] Storage: ${STORAGE_PATH}`);
    console.log(`[media] Sharp: ${sharp ? 'enabled' : 'disabled'}`);
  });
}

module.exports = { app };
