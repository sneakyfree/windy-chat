import { useEffect, useRef, useState } from 'react';
import { env } from '../env';

interface MailPanelProps {
  open: boolean;
  onClose: () => void;
  /** Pre-fill compose view with these params */
  compose?: { body?: string; to?: string } | null;
}

interface MailProvisionState {
  loading: boolean;
  provisioned: boolean | null;
  mailAddress: string | null;
  error: string | null;
}

/**
 * Mail slide-over panel.
 *
 * The Mail surface used to drop the user straight into an iframe to
 * windymail.ai, which is a separate app with its own auth — so users
 * who hadn't gone through Mail provisioning would land on
 * "Authentication required". The new flow:
 *
 *   1. On open, check the user's Mail provisioning state via Pro's
 *      ecosystem-status endpoint.
 *   2. If `windy_mail` isn't active, show an inline Connect-Mail CTA
 *      that POSTs Pro's /mail/provision. The user can finish set-up
 *      without leaving the chat app.
 *   3. Once provisioned, show the assigned mailbox address + a button
 *      that opens windymail.ai in a new tab WITH the Pro JWT carried
 *      across as a URL fragment (same SSO pattern the chat app uses).
 *      Iframe is preserved for ergonomic in-panel access for users
 *      who already authed against windymail.ai directly.
 */
export default function MailPanel({ open, onClose, compose }: MailPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<MailProvisionState>({
    loading: false,
    provisioned: null,
    mailAddress: null,
    error: null,
  });
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Check Mail provisioning state on open.
  useEffect(() => {
    if (!open) return;
    const token = localStorage.getItem('windy_jwt');
    if (!token) {
      setState({ loading: false, provisioned: false, mailAddress: null, error: null });
      return;
    }
    setState(s => ({ ...s, loading: true, error: null }));
    fetch(`${env.accountServerUrl}/api/v1/identity/ecosystem-status`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        const mail = data?.products?.windy_mail;
        const provisioned = mail?.status === 'active';
        setState({
          loading: false,
          provisioned,
          mailAddress: provisioned ? (mail?.external_id || null) : null,
          error: null,
        });
      })
      .catch(() => setState({ loading: false, provisioned: false, mailAddress: null, error: 'Could not check Mail status.' }));
  }, [open]);

  const connectMail = async () => {
    const token = localStorage.getItem('windy_jwt');
    if (!token) return;
    setConnecting(true);
    setState(s => ({ ...s, error: null }));
    try {
      const res = await fetch(`${env.accountServerUrl}/api/v1/identity/mail/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: '{}',
      });
      if (!res.ok) {
        setState(s => ({ ...s, error: `Could not provision Mail (HTTP ${res.status})` }));
        return;
      }
      const data = await res.json();
      setState({
        loading: false,
        provisioned: true,
        mailAddress: data.mail_address || null,
        error: null,
      });
    } catch (err: any) {
      setState(s => ({ ...s, error: err?.message || 'Could not provision Mail.' }));
    } finally {
      setConnecting(false);
    }
  };

  if (!open) return null;

  const jwt = localStorage.getItem('windy_jwt') || '';
  let iframeSrc = env.windyMailUrl;
  const params = new URLSearchParams();
  if (compose) {
    params.set('compose', 'true');
    if (compose.body) params.set('body', compose.body);
    if (compose.to) params.set('to', compose.to);
  }
  if (params.toString()) iframeSrc += '?' + params.toString();
  // SSO handoff — pattern from the chat app's #token= fragment. windymail.ai
  // strips the fragment from history on arrival. Fragments are browser-local
  // (never sent to servers).
  if (jwt) iframeSrc += '#token=' + encodeURIComponent(jwt);
  const openExternal = () => window.open(iframeSrc, '_blank', 'noopener,noreferrer');

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30 transition-opacity" onClick={onClose} />

      <div
        ref={panelRef}
        className="fixed top-0 right-0 z-50 h-full w-[400px] max-w-full flex flex-col shadow-2xl animate-slide-in-right"
        style={{ background: 'var(--bg-primary)' }}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b" style={{ borderColor: 'var(--bg-tertiary)', background: 'var(--bg-secondary)' }}>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
            style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
          >
            ✕
          </button>
          <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>Windy Mail</span>
        </div>

        {/* Not-yet-provisioned: Connect CTA */}
        {state.loading && (
          <div className="flex-1 flex items-center justify-center text-sm" style={{ color: 'var(--text-muted)' }}>
            Loading…
          </div>
        )}
        {!state.loading && state.provisioned === false && (
          <div className="flex-1 flex flex-col items-center justify-center px-8 text-center">
            <div className="text-5xl mb-4">✉️</div>
            <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
              Set up Windy Mail
            </h3>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              You'll get a windymail.ai address, encrypted inbox, and cross-product threading with chat + cloud.
              One click — no extra signup.
            </p>
            <button
              type="button"
              onClick={connectMail}
              disabled={connecting}
              className="px-6 py-2.5 rounded-xl text-sm font-medium disabled:opacity-40"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {connecting ? 'Setting up…' : 'Connect Windy Mail'}
            </button>
            {state.error && (
              <p role="alert" className="text-xs mt-4" style={{ color: 'var(--danger)' }}>
                {state.error}
              </p>
            )}
          </div>
        )}

        {/* Provisioned: show address + iframe + external-open */}
        {!state.loading && state.provisioned && (
          <>
            {state.mailAddress && (
              <div className="px-4 py-2 border-b text-xs flex items-center justify-between" style={{ borderColor: 'var(--bg-tertiary)' }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Your mailbox: <code style={{ color: 'var(--accent)' }}>{state.mailAddress}</code>
                </span>
                <button
                  type="button"
                  onClick={openExternal}
                  className="text-xs underline"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  Open in new tab ↗
                </button>
              </div>
            )}
            <iframe
              src={iframeSrc}
              className="flex-1 w-full border-0"
              title="Windy Mail"
              allow="clipboard-write"
            />
          </>
        )}
      </div>
    </>
  );
}
