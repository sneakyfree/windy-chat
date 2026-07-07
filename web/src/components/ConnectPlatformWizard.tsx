/**
 * Connect-a-platform wizard — a generic renderer for the typed login
 * steps the hub service exposes (user_input forms, scan-this-code
 * display_and_wait steps, completion). Works for any platform the
 * backend lists; today that's Telegram.
 *
 * Copy rules: users see "Link Telegram" / "Connected platforms" — the
 * protocol machinery is never named in the UI.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import * as hub from '../lib/hub';
import { PLATFORM_META } from '../lib/provenance';

interface ConnectPlatformWizardProps {
  platform: hub.HubPlatform;
  onClose: () => void;
  /** Called once the account is linked so the parent can refresh. */
  onConnected: () => void;
}

type Phase = 'flows' | 'step' | 'waiting' | 'done' | 'fatal';

function friendlyError(err: unknown): string {
  if (hub.isNoChatAccount(err)) {
    return "Your Windy Chat account isn't finished setting up yet. Send a message in Windy Chat first, then come back and try again.";
  }
  if (err instanceof hub.HubApiError) return err.message;
  if (err instanceof Error) return err.message || 'Something went wrong. Please try again.';
  return 'Something went wrong. Please try again.';
}

/** Pick sensible input attributes for a login form field. */
function inputPropsFor(field: hub.LoginStepField): {
  type: string;
  inputMode?: 'tel' | 'numeric' | 'email' | 'text';
  placeholder: string;
  autoComplete?: string;
} {
  const t = field.type.toLowerCase();
  if (t.includes('phone')) {
    return { type: 'tel', inputMode: 'tel', placeholder: '+1 555 000 1234', autoComplete: 'tel' };
  }
  if (t.includes('password')) {
    return { type: 'password', placeholder: 'Password', autoComplete: 'current-password' };
  }
  if (t.includes('email')) {
    return { type: 'email', inputMode: 'email', placeholder: 'you@example.com', autoComplete: 'email' };
  }
  if (t.includes('code') || t.includes('2fa') || t.includes('token')) {
    return { type: 'text', inputMode: 'numeric', placeholder: 'Code', autoComplete: 'one-time-code' };
  }
  return { type: 'text', placeholder: field.name || field.id };
}

export default function ConnectPlatformWizard({
  platform,
  onClose,
  onConnected,
}: ConnectPlatformWizardProps) {
  const [phase, setPhase] = useState<Phase>('flows');
  const [flows, setFlows] = useState<hub.LoginFlow[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(true);
  const [step, setStep] = useState<hub.LoginStep | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [completedAs, setCompletedAs] = useState<string | null>(null);

  // login_id survives across steps; step_id changes per step.
  const loginIdRef = useRef<string | null>(null);
  // Generation token — bumping it cancels any in-flight wait loop
  // (unmount, close, or a fresh start). React 18 StrictMode double-mounts
  // effects in dev, so every async loop checks this before applying state.
  const generationRef = useRef(0);
  const startedRef = useRef(false);

  useEffect(() => {
    const generation = generationRef; // not a DOM ref — cancellation token
    generation.current++;
    return () => {
      // Invalidate any in-flight loops from this mount when unmounting.
      generation.current++;
    };
  }, []);

  const meta = PLATFORM_META[platform.key] || { label: platform.displayName, color: 'var(--accent)' };
  const displayName = platform.displayName || meta.label;

  // ── Step handling ──

  const renderQr = useCallback(async (data: string, gen: number) => {
    try {
      const url = await QRCode.toDataURL(data, { width: 240, margin: 1 });
      if (generationRef.current === gen) setQrDataUrl(url);
    } catch {
      if (generationRef.current === gen) {
        setError("Couldn't draw the code. Please try again.");
      }
    }
  }, []);

  // Long-poll loop for display_and_wait steps. Each request waits
  // server-side (up to ~125s) and resolves to either a refreshed code
  // step or completion. Codes rotate roughly every minute, so a
  // refreshed step means "draw the new code and keep waiting".
  const waitLoop = useCallback(
    async (current: hub.LoginStep, gen: number) => {
      let active = current;
      let failures = 0;
      while (generationRef.current === gen) {
        const loginId = loginIdRef.current;
        if (!loginId) return;
        let next: hub.LoginStep;
        try {
          next = await hub.submitLoginStep(platform.key, loginId, active.step_id, 'display_and_wait', {});
          failures = 0;
        } catch (err) {
          // The edge in front of the long-poll can cut a connection
          // before the server answers; re-asking the same step just
          // resumes waiting. Give up after repeated hard failures.
          failures++;
          if (err instanceof hub.HubApiError && err.status >= 400 && err.status < 500) {
            if (generationRef.current === gen) {
              setError(friendlyError(err));
              setPhase('fatal');
            }
            return;
          }
          if (failures >= 5) {
            if (generationRef.current === gen) {
              setError("We couldn't finish linking. Please try again.");
              setPhase('fatal');
            }
            return;
          }
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (generationRef.current !== gen) return;
        if (next.type === 'complete') {
          setCompletedAs(next.complete?.user_id || null);
          setPhase('done');
          onConnected();
          return;
        }
        if (next.type === 'display_and_wait') {
          active = next;
          setStep(next);
          if (next.display_and_wait?.type === 'qr' && next.display_and_wait.data) {
            void renderQr(next.display_and_wait.data, gen);
          }
          continue; // immediately wait on the refreshed step
        }
        // Fell back to a form step (e.g. 2FA password after scanning).
        setStep(next);
        setValues({});
        setQrDataUrl(null);
        setPhase('step');
        return;
      }
    },
    [platform.key, onConnected, renderQr],
  );

  const handleStep = useCallback(
    (next: hub.LoginStep) => {
      const gen = generationRef.current;
      if (next.login_id) loginIdRef.current = next.login_id;
      if (next.type === 'complete') {
        setCompletedAs(next.complete?.user_id || null);
        setPhase('done');
        onConnected();
        return;
      }
      setStep(next);
      setValues({});
      if (next.type === 'display_and_wait') {
        setQrDataUrl(null);
        if (next.display_and_wait?.type === 'qr' && next.display_and_wait.data) {
          void renderQr(next.display_and_wait.data, gen);
        }
        setPhase('waiting');
        void waitLoop(next, gen);
      } else {
        setPhase('step');
      }
    },
    [onConnected, renderQr, waitLoop],
  );

  const startFlow = useCallback(
    async (flowId: string) => {
      setBusy(true);
      setError('');
      try {
        const first = await hub.startLogin(platform.key, flowId);
        handleStep(first);
      } catch (err) {
        setError(friendlyError(err));
        if (hub.isNoChatAccount(err)) setPhase('fatal');
      } finally {
        setBusy(false);
      }
    },
    [platform.key, handleStep],
  );

  // Load the available sign-in methods once.
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const list = await hub.getLoginFlows(platform.key);
        if (cancelled) return;
        setFlows(list);
        setFlowsLoading(false);
        if (list.length === 1) void startFlow(list[0].id);
      } catch (err) {
        if (cancelled) return;
        setFlowsLoading(false);
        setError(friendlyError(err));
        if (hub.isNoChatAccount(err)) setPhase('fatal');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [platform.key, startFlow]);

  const submitForm = useCallback(async () => {
    if (!step || !loginIdRef.current) return;
    setBusy(true);
    setError('');
    try {
      const next = await hub.submitLoginStep(
        platform.key,
        loginIdRef.current,
        step.step_id,
        'user_input',
        values,
      );
      handleStep(next);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }, [platform.key, step, values, handleStep]);

  const fields = step?.user_input?.fields ?? [];
  const formReady = fields.every((f) => (values[f.id] ?? '').trim().length > 0);

  const isPhoneFlow = (f: hub.LoginFlow) =>
    f.id.toLowerCase().includes('phone') || (f.name || '').toLowerCase().includes('phone');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative w-full max-w-md rounded-2xl shadow-2xl flex flex-col"
        style={{ background: 'var(--bg-secondary)', border: '1px solid var(--bg-tertiary)', maxHeight: '85vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="px-6 py-4 border-b flex items-center justify-between shrink-0"
          style={{ borderColor: 'var(--bg-tertiary)' }}
        >
          <div className="flex items-center gap-2.5">
            <span className="w-3 h-3 rounded-full shrink-0" style={{ background: meta.color }} />
            <h2 className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
              {phase === 'done' ? `${displayName} linked!` : `Link ${displayName}`}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            &times;
          </button>
        </div>

        <div className="p-6 overflow-y-auto">
          {/* ── Fatal error (e.g. chat account not ready) ── */}
          {phase === 'fatal' && (
            <div className="text-center py-4">
              <div className="text-4xl mb-3">😕</div>
              <p className="text-sm mb-6" style={{ color: 'var(--text-primary)' }}>{error}</p>
              <button
                onClick={onClose}
                className="px-6 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
              >
                Close
              </button>
            </div>
          )}

          {/* ── Success ── */}
          {phase === 'done' && (
            <div className="text-center py-4">
              <div className="text-4xl mb-3">🎉</div>
              <p className="text-sm mb-1" style={{ color: 'var(--text-primary)' }}>
                Your {displayName} account is now connected.
              </p>
              {completedAs && (
                <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>
                  Signed in{completedAs ? ` (${completedAs.split(':')[0].replace('@', '')})` : ''}
                </p>
              )}
              <p className="text-xs mb-6" style={{ color: 'var(--text-muted)' }}>
                Your {displayName} conversations will start appearing in your chat list shortly.
              </p>
              <button
                onClick={onClose}
                className="px-6 py-2.5 rounded-xl text-sm font-medium"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                Done
              </button>
            </div>
          )}

          {/* ── Flow picker ── */}
          {phase === 'flows' && (
            <>
              {flowsLoading ? (
                <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  Loading sign-in options…
                </p>
              ) : flows.length === 0 && !error ? (
                <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                  No sign-in options available right now. Please try again later.
                </p>
              ) : (
                <>
                  <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                    How would you like to sign in to {displayName}?
                  </p>
                  <div className="space-y-2">
                    {flows.map((flow) => (
                      <button
                        key={flow.id}
                        disabled={busy}
                        onClick={() => startFlow(flow.id)}
                        className="w-full text-left px-4 py-3 rounded-xl transition-colors disabled:opacity-40"
                        style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                      >
                        <span className="text-sm font-medium flex items-center gap-2">
                          {flow.name || flow.id}
                          {isPhoneFlow(flow) && (
                            <span
                              className="text-[10px] px-1.5 py-0.5 rounded-full"
                              style={{ background: 'var(--accent)', color: 'white' }}
                            >
                              Recommended
                            </span>
                          )}
                        </span>
                        {flow.description && (
                          <span className="text-xs block mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                            {flow.description}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Form step ── */}
          {phase === 'step' && step && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (formReady && !busy) void submitForm();
              }}
            >
              {step.instructions && (
                <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                  {step.instructions}
                </p>
              )}
              {fields.map((field) => {
                const props = inputPropsFor(field);
                return (
                  <div key={field.id} className="mb-4">
                    <label
                      className="text-xs font-medium mb-2 block"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      {field.name || field.id}
                    </label>
                    <input
                      type={props.type}
                      inputMode={props.inputMode}
                      autoComplete={props.autoComplete}
                      placeholder={props.placeholder}
                      value={values[field.id] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                      autoFocus={field === fields[0]}
                      className="w-full px-4 py-3 rounded-xl text-sm outline-none"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                    />
                    {field.description && (
                      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {field.description}
                      </p>
                    )}
                  </div>
                );
              })}
              <button
                type="submit"
                disabled={!formReady || busy}
                className="w-full py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-40"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {busy ? 'Working…' : 'Continue'}
              </button>
            </form>
          )}

          {/* ── Scan-code step ── */}
          {phase === 'waiting' && step && (
            <div className="text-center">
              <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
                {step.instructions ||
                  `Open ${displayName} on your phone and scan this code to link your account.`}
              </p>
              {step.display_and_wait?.type === 'qr' ? (
                qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={`Scan this code with the ${displayName} app`}
                    className="mx-auto rounded-xl"
                    style={{ width: 240, height: 240, background: 'white', padding: 8 }}
                  />
                ) : (
                  <div
                    className="mx-auto rounded-xl flex items-center justify-center"
                    style={{ width: 240, height: 240, background: 'var(--bg-tertiary)' }}
                  >
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Preparing code…
                    </span>
                  </div>
                )
              ) : step.display_and_wait?.data ? (
                // Non-QR codes (pairing code / emoji) — show them big.
                <div
                  className="mx-auto px-6 py-4 rounded-xl text-2xl font-mono tracking-widest inline-block"
                  style={{ background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                >
                  {step.display_and_wait.data}
                </div>
              ) : (
                <p className="text-sm py-6" style={{ color: 'var(--text-muted)' }}>
                  Waiting for confirmation…
                </p>
              )}
              <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
                The code refreshes automatically — keep this window open.
              </p>
            </div>
          )}

          {/* Inline (non-fatal) errors */}
          {error && phase !== 'fatal' && (
            <div
              className="text-sm px-3 py-2 rounded-lg mt-4"
              style={{ color: 'var(--danger)', background: 'rgba(248,113,113,0.1)' }}
            >
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
