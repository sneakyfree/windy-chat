/**
 * Windy Chat — Shared body-parser error translator
 *
 * Express's default error handler swallows body-parser rejections (oversized
 * body, malformed JSON) as generic 500s. Normal rejections end up
 * indistinguishable from actual crashes in logs, and clients see 500 when
 * they should see 413 or 400.
 *
 * Mount BEFORE other error handlers and after `express.json(...)`:
 *
 *   app.use(express.json({ limit: '5mb', verify: ... }));
 *   // ... routes ...
 *   app.use(bodyErrorHandler());
 *   app.use(sentryErrorHandler());
 *   app.use(genericHandler);
 */

function bodyErrorHandler() {
  return (err, _req, res, next) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Payload too large',
        limit: err.limit,
        length: err.length,
      });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Malformed JSON' });
    }
    if (err.type === 'entity.verify.failed') {
      // Thrown by our express.json({ verify }) hook when raw-body capture
      // fails — rare, but treat as a client error rather than 500.
      return res.status(400).json({ error: 'Request body verification failed' });
    }
    if (err.type === 'encoding.unsupported') {
      return res.status(415).json({ error: 'Unsupported encoding' });
    }
    next(err);
  };
}

module.exports = { bodyErrorHandler };
