import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CreditCard,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LifeBuoy,
  LockKeyhole,
  Mail,
  Moon,
  ShieldCheck,
  Sun,
  UserRound,
  WifiOff,
} from 'lucide-react';
import { Button, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import * as api from '@/lib/api';
import { keys } from '@/lib/queries';
import { passwordProblem, passwordStrength, MIN_PASSWORD_LENGTH } from '../../shared/password';
import { applyTheme, resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';
import { cn } from '@/lib/utils';
import { LINKS, appHref, siteHref } from '@/lib/links';

type Mode = 'login' | 'mfa' | 'setup' | 'register' | 'forgot' | 'reset' | 'invite' | 'help';

interface Status {
  needsSetup: boolean;
  requiresSetupToken: boolean;
  selfRegistration: boolean;
  cac?: { enabled: boolean; exclusive: boolean };
  /** Sign-in through the organization's identity provider (Entra ID and the like). */
  sso?: { enabled: boolean; label: string; exclusive: boolean };
  emailEnabled: boolean;
  displayName: string;
  announcement: string;
  maintenance: boolean;
  /** What everyone is told while maintenance is on, and when it should end (ADR-0011). Older servers do not send it. */
  maintenanceNotice?: { message: string; until: string | null } | null;
  /** A notice the person must accept before any sign-in, such as the DoD Notice and Consent Banner. */
  consent?: string | null;
}

/** Why an organization sign-in came back without a session; the server sends the code, not the words. */
const SSO_ERRORS: Record<string, string> = {
  oidc_unlinked: 'Your organization account is not linked to a Vantage account here. Ask your unit leader or Vantage support to add you, then sign in again.',
  oidc_conflict: 'That Vantage account is already linked to a different organization account. Ask Vantage support to check it.',
  oidc_inactive: 'That Vantage account is turned off. Ask your unit leader or Vantage support.',
  oidc_denied: 'Your organization did not sign you in. Try again, or ask your help desk.',
  oidc_expired: 'The sign-in took too long. Try again.',
  oidc_state: 'That sign-in was already used or has expired. Start again.',
  oidc_bad_token: 'Your organization’s answer could not be verified, so you were not signed in. If this keeps happening, tell Vantage support.',
  oidc_unreachable: 'Your organization’s sign-in service could not be reached. Try again in a minute.',
  oidc_misconfigured: 'Organization sign-in is not set up correctly here. Tell Vantage support.',
  consent_required: 'Read and accept the notice first.',
  maintenance: 'Vantage is in maintenance, and new accounts are made again once it ends. Try again then.',
  console_owners_only: 'This console is not for your account. Sign in to the app instead.',
  throttled: 'Too many sign-in attempts. Wait a few minutes and try again.',
};

function useRanks() {
  const [ranks, setRanks] = useState<Array<{ id: string; abbr: string; name: string }>>([]);
  useEffect(() => {
    api.api.get('/ranks').then((r) => setRanks(Array.isArray(r) ? r : [])).catch(() => setRanks([]));
  }, []);
  return ranks;
}

function PasswordMeter({ value }: { value: string }) {
  if (!value) return null;
  const strength = passwordStrength(value);
  const problem = passwordProblem(value);
  return (
    <div className="mt-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn('h-1 flex-1 rounded-full', i < strength.score ? (strength.score >= 3 ? 'bg-good' : strength.score === 2 ? 'bg-warn' : 'bg-bad') : 'bg-surface-3')} />
        ))}
      </div>
      <p className={cn('mt-1 text-2xs', problem ? 'text-ink-3' : 'text-good')}>{problem || `${strength.label}. Long and memorable beats short and clever.`}</p>
    </div>
  );
}

/**
 * The sign-in screen of the application, of the Unit Manager console (variant="console", for the people who hold a Unit
 * Instance's roles) or of the Vantage Administrator console (variant="admin", for Vantage staff).
 */
export default function Login({ serverError, onRetry, variant = 'app' }: { serverError: string | null; onRetry: () => void; variant?: 'app' | 'console' | 'admin' }) {
  const owners = variant !== 'app';
  const faceName = variant === 'admin' ? 'Vantage Administrator console' : 'Unit Manager console';
  const qc = useQueryClient();
  const toast = useToast();
  const ranks = useRanks();
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const path = window.location.pathname;
  const [mode, setMode] = useState<Mode>(() => (
    path.startsWith('/reset') && params.get('token') ? 'reset'
      : path.startsWith('/invite') && params.get('token') ? 'invite'
        : path.startsWith('/register') ? 'register'
          // /login?help opens the request form straight away; the security page links here with ?help=security.
          : path.startsWith('/login') && params.has('help') ? 'help'
            : 'login'
  ));
  const securityReport = params.get('help') === 'security';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => {
    const code = params.get('sso_error');
    return code ? SSO_ERRORS[code] || 'Organization sign-in did not finish. Try again.' : '';
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({
    username: '', password: '', first_name: '', last_name: '', middle_initial: '', rank_id: '', mos: '', email: '', unit_name: '', unit_short_name: '', setup_token: '', code: '', identifier: '', help_subject: '', help_body: '',
  });
  const [challenge, setChallenge] = useState('');
  const [tokenInfo, setTokenInfo] = useState<any>(null);
  const [theme, setTheme] = useState(() => resolveTheme(storedTheme()));
  const [consented, setConsented] = useState(() => api.consentWasAccepted());
  // Until the notice is accepted, the forms behind it are not shown.
  const gated = Boolean(status?.consent) && !consented;

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [key]: e.target.value }));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  useEffect(() => {
    // The shell this renders in is already kept out of search results; only the tab needs naming.
    document.title = 'Sign in | Vantage';
    if (params.has('sso_error')) {
      const rest = new URLSearchParams(params);
      rest.delete('sso_error');
      const query = rest.toString();
      window.history.replaceState(null, '', `${path}${query ? `?${query}` : ''}`);
    }

    api.setupStatus().then((s: Status) => {
      setStatus(s);
      if (s.needsSetup && mode === 'login' && !owners) setMode('setup');
    }).catch((e) => setStatusError(api.errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const token = params.get('token') || '';
    if (mode === 'reset' && token) api.resetStatus(token).then(setTokenInfo).catch(() => setTokenInfo({ valid: false }));
    if (mode === 'invite' && token) {
      api.inviteStatus(token).then((info) => {
        setTokenInfo(info);
        if (info?.suggested) {
          setForm((current) => ({
            ...current,
            first_name: info.suggested.first_name || '',
            last_name: info.suggested.last_name || '',
            rank_id: info.suggested.rank_id || '',
            email: info.email || '',
          }));
        }
      }).catch(() => setTokenInfo({ valid: false }));
    }
  }, [mode, params]);

  // An invitation stays in the address through sign-in, so an existing account lands on it and accepts it (ADR-0009).
  const inviteToken = path.startsWith('/invite') ? params.get('token') : null;
  const finish = () => {
    qc.invalidateQueries({ queryKey: keys.me });
    const authPath = ['/login', '/register', '/reset', '/invite', '/setup'].some((p) => path.startsWith(p));
    const accepted = mode === 'invite' && !noPassword;
    window.history.replaceState(null, '', inviteToken && !accepted ? `/invite?token=${encodeURIComponent(inviteToken)}` : authPath ? '/' : `${window.location.pathname}${window.location.search}`);
  };

  const fail = (e: unknown) => {
    const err = e as api.ApiError;
    setError(err.fieldErrors && Object.keys(err.fieldErrors).length ? 'Check the highlighted fields.' : api.errorText(e));
    setFieldErrors(err.fieldErrors || {});
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setFieldErrors({});
    try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const submitLogin = () => run(async () => {
    const result = await api.login(form.username, form.password);
    if (result.ok) finish();
    else if (result.mfa === 'totp') {
      setChallenge(result.challenge);
      setMode('mfa');
    }
  });
  const submitMfa = () => run(async () => { await api.loginMfa(challenge, form.code); finish(); });
  const submitSetup = () => run(async () => {
    await api.runSetup({ ...form, email: form.email || null, rank_id: form.rank_id || null, mos: form.mos || null, middle_initial: form.middle_initial || null, unit_short_name: form.unit_short_name || null });
    finish();
  });
  const submitRegister = () => run(async () => {
    await api.register({ username: form.username, password: form.password, first_name: form.first_name, last_name: form.last_name, middle_initial: form.middle_initial || null, rank_id: form.rank_id || null, mos: form.mos || null, email: form.email || null });
    finish();
  });
  const submitForgot = () => run(async () => {
    const result = await api.forgotPassword(form.identifier);
    toast.info(result.emailEnabled ? 'If that account has an email on file, a reset link is on its way.' : 'Email is off on Vantage right now. Ask Vantage support through Need help? for a temporary password.');
    setMode('login');
  });
  const submitHelp = () => run(async () => {
    await api.askForHelp({ subject: form.help_subject.trim() || (securityReport ? 'Security vulnerability report' : 'I cannot sign in'), body: form.help_body, category: securityReport ? 'bug' : 'sign_in', requester_name: [form.first_name, form.last_name].filter(Boolean).join(' ') || undefined, requester_email: form.email.trim() });
    toast.success(`Your request is in. Someone who runs Vantage here will write to ${form.email.trim()}.`);
    setForm((current) => ({ ...current, help_subject: '', help_body: '' }));
    setMode('login');
  });
  const submitReset = () => run(async () => {
    const result = await api.resetPassword(params.get('token') || '', form.password);
    if (result?.mfa === 'totp') {
      setChallenge(result.challenge);
      setMode('mfa');
    } else finish();
  });
  const submitInvite = () => run(async () => {
    await api.acceptInvite({ token: params.get('token') || '', username: form.username, password: form.password, first_name: form.first_name, last_name: form.last_name, rank_id: form.rank_id || null, mos: form.mos || null, email: form.email || undefined });
    finish();
  });
  const cac = () => run(async () => { await api.cacLogin(); finish(); });
  // A full-page trip to the organization's sign-in page and back; the notice, if any, was accepted here first.
  const organization = () => {
    const query = new URLSearchParams();
    if (consented) query.set('consent', '1');
    if (!/^\/(login|register|reset|invite|setup)(\/|$)/.test(path)) query.set('return', `${path}${window.location.search}`);
    else if (inviteToken) query.set('return', `/invite?token=${encodeURIComponent(inviteToken)}`);
    setBusy(true);
    const qs = query.toString();
    window.location.assign(`/api/auth/oidc/start${qs ? `?${qs}` : ''}`);
  };
  const noPassword = Boolean(status?.cac?.exclusive || status?.sso?.exclusive);
  const passkey = () => run(async () => {
    const { options, key } = await api.passkeyOptions(form.username || undefined);
    let response;
    try {
      response = await startAuthentication({ optionsJSON: options });
    } catch (e) {
      throw new Error((e as Error).name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : (e as Error).message);
    }
    await api.passkeyVerify(key, response);
    finish();
  });

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    applyTheme(next);
  };

  const rankOptions = [{ value: '__none', label: 'No rank yet' }, ...ranks.map((rank) => ({ value: rank.id, label: `${rank.abbr} · ${rank.name}` }))];
  const RankSelect = <Select aria-label="Rank" value={form.rank_id || '__none'} onValueChange={(value) => setForm((current) => ({ ...current, rank_id: value === '__none' ? '' : value }))} options={rankOptions} />;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  const heading: Record<Mode, [string, string, string]> = {
    login: variant === 'admin' ? ['Vantage Administrator console', 'Sign in', 'For Vantage staff. Commands sign in to the app or their Unit Manager console.']
      : owners ? ['Unit Manager console', 'Sign in', 'For the people who run a Unit Instance on Vantage. Everyone else signs in to the app.'] : ['Welcome back', 'Sign in', 'Continue to your Vantage workspace.'],
    mfa: ['Secure sign-in', 'Second step', 'Enter the six-digit code from your authenticator app, or a recovery code.'],
    setup: ['First launch', 'Set up Vantage', 'Create the first Lead Vantage Administrator account and the first Unit Instance. This only happens once.'],
    register: ['Join Vantage', 'Create your account', 'Then join your unit with a join code or invitation from your leader.'],
    forgot: ['Account recovery', 'Reset your password', 'Enter your username or email. If email is configured, a one-time link follows.'],
    reset: tokenInfo?.purpose === 'sign_in'
      ? ['Welcome to Vantage', 'Choose your password', `You sign in as ${tokenInfo.username}. Choose a password to finish; you are signed in as soon as it is saved.`]
      : ['Account recovery', 'Choose a new password', tokenInfo?.email ? `Resetting the account for ${tokenInfo.email}.` : 'This link works once and expires after 30 minutes.'],
    help: ['Account recovery', 'Ask for help', 'Tell the people who run Vantage here what is wrong. You need no account to ask, and nobody will ever ask for your password.'],
    invite: ['Your invitation', 'Accept your invitation', `${tokenInfo?.unit ? `${tokenInfo.invitedBy || 'A leader'} invited you to ${tokenInfo.unit}. ` : ''}${noPassword ? 'Sign in to accept it.' : 'New to Vantage? Create your account below.'}`],
  };

  const passwordInput = (
    <div className="auth-password-wrap" role="group" aria-label="Password controls">
      <Input
        aria-label="Password"
        type={showPassword ? 'text' : 'password'}
        required
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        value={form.password}
        onChange={set('password')}
      />
      <button type="button" className="auth-eye" onClick={() => setShowPassword((v) => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
        {showPassword ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );

  return (
    <div className="auth-page">
      <aside className="auth-brand-panel" aria-label="About Vantage">
        <div className="auth-brand-glow" aria-hidden />
        <a href={siteHref('/')} className="auth-panel-brand" aria-label="Vantage overview">
          <img src="/brand/mark-reversed.svg" alt="" width="28" height="28" />
          <span>VANTAGE</span>
        </a>
        <div className="auth-panel-copy">
          <p className="auth-panel-eyebrow">Performance and work management</p>
          <p className="auth-panel-title">Every action.<br /><span>A clearer picture.</span></p>
          <ul className="auth-panel-points">
            <li><ShieldCheck strokeWidth={1.75} aria-hidden /><span><b>Answerable</b>Every case history is sealed, and every change to a record is attributed.</span></li>
            <li><LockKeyhole strokeWidth={1.75} aria-hidden /><span><b>Private by default</b>Your record is yours; leaders see what you share, for their unit only.</span></li>
            <li><Fingerprint strokeWidth={1.75} aria-hidden /><span><b>Sign in your way</b>Passkeys, authenticator codes and CAC, with sessions you can end.</span></li>
          </ul>
        </div>
        <p className="auth-panel-foot">Independent software project. Not an official DoD or USMC system of record.</p>
      </aside>

      <div className="auth-side">
      <header className="auth-topbar">
        <a href={owners ? appHref('/') : siteHref('/')} className="auth-top-brand" aria-label={owners ? 'Open the Vantage app' : 'Vantage overview'}>
          <img src="/mark.svg" alt="" />
          <span>VANTAGE</span>
        </a>
        <div className="auth-top-actions">
          {owners
            ? <a href={appHref('/')} className="auth-overview-link">Open the app <ArrowRight /></a>
            : LINKS.publicSite ? <a href={siteHref('/display')} className="auth-overview-link">About Vantage <ArrowRight /></a> : null}
          <button type="button" onClick={toggleTheme} className="auth-theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      <main className="auth-stage">
        <section className="auth-shell" aria-labelledby="auth-heading">
          <div className={cn('auth-brand-lockup', !(status?.displayName && status.displayName !== 'Vantage') && 'auth-brand-lockup-default')}>
            <div className="auth-mark-wrap"><img src="/mark.svg" alt="" /></div>
            <p>{status?.displayName && status.displayName !== 'Vantage' ? status.displayName : 'VANTAGE'}</p>
            <span>{owners ? faceName : status?.displayName && status.displayName !== 'Vantage' ? 'Powered by Vantage' : 'Performance · Productivity · Readiness'}</span>
          </div>

          <div className="auth-card">
            {mode !== 'login' && mode !== 'setup' && (
              <button type="button" onClick={() => { setMode('login'); setError(''); }} className="auth-back">
                <ArrowLeft /> Back to sign in
              </button>
            )}

            <div className="auth-heading-block">
              <p className="auth-eyebrow">{heading[mode][0]}</p>
              <h1 id="auth-heading">{heading[mode][1]}</h1>
              <p>{heading[mode][2]}</p>
            </div>

            {status?.announcement && <div className="auth-notice accent">{status.announcement}</div>}
            {owners && status?.needsSetup && <div className="auth-notice accent">Vantage is not set up yet. <a className="link" href={appHref('/setup')}>Set it up in the app</a>, then come back here.</div>}
            {status?.maintenance && <div className="auth-notice warn">{status.maintenanceNotice?.message ?? 'Vantage is in maintenance.'} Only Vantage staff can sign in right now.</div>}
            {(serverError || statusError) && (
              <div className="auth-notice error">
                <WifiOff /><span>{serverError || statusError}</span>
                <Button size="xs" onClick={() => { setStatusError(''); onRetry(); api.setupStatus().then(setStatus).catch((e) => setStatusError(api.errorText(e))); }}>Retry</Button>
              </div>
            )}
            {error && <div role="alert" className="auth-notice error compact">{error}</div>}

            {gated && (
              <div className="auth-form" role="region" aria-labelledby="consent-heading">
                <h2 id="consent-heading" className="text-sm font-semibold text-ink">Notice and consent</h2>
                <div className="max-h-72 overflow-y-auto whitespace-pre-line rounded-md border border-line bg-surface-2 p-3 text-xs leading-relaxed text-ink-2" tabIndex={0}>{status?.consent}</div>
                <Button type="button" variant="primary" size="lg" className="auth-submit" autoFocus onClick={() => { api.acceptConsent(); setConsented(true); }}>I agree</Button>
              </div>
            )}

            {!gated && (mode === 'login' || mode === 'invite') && noPassword && (
              <div className="auth-form">
                {status?.sso?.enabled && <Button type="button" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={offline} onClick={organization}><Building2 className="h-4 w-4" /> {status.sso.label}</Button>}
                {status?.cac?.enabled && <Button type="button" variant={status?.sso?.enabled ? 'outline' : 'primary'} size="lg" className={status?.sso?.enabled ? 'auth-passkey' : 'auth-submit'} loading={busy && !status?.sso?.enabled} disabled={offline || (busy && Boolean(status?.sso?.enabled))} onClick={cac}><CreditCard className="h-4 w-4" /> Sign in with your CAC</Button>}
                <p className="text-sm text-ink-3">
                  {status?.cac?.enabled ? 'For your CAC, put your card in the reader first; your browser asks which certificate to use and for your PIN. ' : 'Your organization’s sign-in page opens, then brings you back here. '}
                  {!owners && <button type="button" className="link" onClick={() => setMode('help')}>Need help?</button>}
                </p>
              </div>
            )}

            {!gated && mode === 'login' && !noPassword && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
                <Field label="Username" error={fieldErrors.username}>
                  <div className="auth-input-wrap" role="group" aria-label="Username controls"><UserRound /><Input aria-label="Username" autoFocus required autoComplete="username webauthn" spellCheck={false} autoCapitalize="none" value={form.username} onChange={set('username')} /></div>
                </Field>
                <Field label="Password" error={fieldErrors.password}>
                  <div className="auth-input-wrap" role="group" aria-label="Password field"><LockKeyhole />{passwordInput}</div>
                </Field>
                <div className="auth-form-links">
                  <button type="button" className="link" onClick={() => setMode('forgot')}>Forgot your password?</button>
                  {status?.selfRegistration && !owners && <button type="button" className="link" onClick={() => setMode('register')}>Create an account</button>}
                  {!owners && <button type="button" className="link" onClick={() => setMode('help')}>Need help?</button>}
                </div>
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={offline}>
                  Sign in <ArrowRight className="h-4 w-4" />
                </Button>
                <div className="auth-divider"><span>or continue with</span></div>
                {status?.sso?.enabled && <Button type="button" variant="outline" size="lg" className="auth-passkey" onClick={organization} disabled={busy || offline}><Building2 className="h-4 w-4" /> {status.sso.label}</Button>}
                <Button type="button" variant="outline" size="lg" className="auth-passkey" onClick={passkey} disabled={busy || offline}>
                  <Fingerprint className="h-4 w-4" /> Sign in with a passkey
                </Button>
                {status?.cac?.enabled && <Button type="button" variant="outline" size="lg" className="auth-passkey" onClick={cac} disabled={busy || offline}><CreditCard className="h-4 w-4" /> Sign in with your CAC</Button>}
              </form>
            )}

            {!gated && mode === 'mfa' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitMfa(); }}>
                <Field label="Code" hint="6 digits, or a recovery code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={form.code} onChange={set('code')} className="fig text-lg tracking-[0.3em]" /></Field>
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={form.code.replace(/\s/g, '').length < 6}><ShieldCheck className="h-4 w-4" /> Verify</Button>
              </form>
            )}

            {!gated && (mode === 'setup' || mode === 'register' || (mode === 'invite' && !noPassword)) && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); (mode === 'setup' ? submitSetup : mode === 'register' ? submitRegister : submitInvite)(); }}>
                {mode === 'invite' && tokenInfo && !tokenInfo.valid && <div className="auth-notice error compact">This invitation is invalid or has expired. Ask your leader for a new one.</div>}
                {mode === 'invite' && tokenInfo?.valid && <div className="auth-notice accent compact">Already use Vantage? <button type="button" className="link" onClick={() => { setMode('login'); setError(''); }}>Sign in to accept it</button> with the account you have, so your record and history stay together.</div>}
                {mode === 'setup' && status?.requiresSetupToken && <Field label="Deployment setup token" hint="from the server environment" error={fieldErrors.setup_token}><Input autoFocus value={form.setup_token} onChange={set('setup_token')} autoComplete="off" /></Field>}
                <div className="auth-two-col">
                  <Field label="First name" required error={fieldErrors.first_name}><Input value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></Field>
                  <Field label="Last name" required error={fieldErrors.last_name}><Input value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></Field>
                  <Field label="Rank" error={fieldErrors.rank_id}>{RankSelect}</Field>
                  <Field label="MOS" error={fieldErrors.mos}><Input value={form.mos} onChange={set('mos')} placeholder="3451" /></Field>
                </div>
                <Field label="Username" required hint="letters, numbers, dot, dash, underscore" error={fieldErrors.username}><Input value={form.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
                <Field label="Email" hint={mode === 'invite' && tokenInfo?.email ? 'set by the invitation' : 'optional; used for reset links and the weekly digest'} error={fieldErrors.email}><Input type="email" spellCheck={false} value={form.email} onChange={set('email')} autoComplete="email" disabled={mode === 'invite' && Boolean(tokenInfo?.email)} /></Field>
                <Field label="Password" required hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={fieldErrors.password}>{passwordInput}</Field>
                <PasswordMeter value={form.password} />
                {!gated && mode === 'setup' && (
                  <div className="auth-two-col auth-unit-fields">
                    <Field label="First unit" required hint="you will lead it" error={fieldErrors.unit_name}><Input value={form.unit_name} onChange={set('unit_name')} placeholder="Comptroller, MCB Quantico" /></Field>
                    <Field label="Short name" error={fieldErrors.unit_short_name}><Input value={form.unit_short_name} onChange={set('unit_short_name')} placeholder="G-8" /></Field>
                  </div>
                )}
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={Boolean(passwordProblem(form.password)) || !form.username || !form.first_name || !form.last_name || (mode === 'invite' && tokenInfo && !tokenInfo.valid)}>
                  {mode === 'setup' ? 'Create Lead Vantage Administrator account' : mode === 'register' ? 'Create account' : 'Join and sign in'} <ArrowRight className="h-4 w-4" />
                </Button>
              </form>
            )}

            {!gated && mode === 'forgot' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitForgot(); }}>
                <Field label="Username or email"><Input autoFocus value={form.identifier} onChange={set('identifier')} autoCapitalize="none" /></Field>
                {status && !status.emailEnabled && <p className="text-xs text-ink-3">Email is off on Vantage right now. Ask Vantage support through Need help? and they can set you a temporary password.</p>}
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={!form.identifier}><Mail className="h-4 w-4" /> Send reset link</Button>
                <p className="text-sm text-ink-3">Still stuck? <button type="button" className="link" onClick={() => setMode('help')}>Ask for help</button></p>
              </form>
            )}

            {!gated && mode === 'help' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitHelp(); }}>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name"><Input autoFocus value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></Field>
                  <Field label="Last name"><Input value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></Field>
                </div>
                <Field label="Your email" hint="where the answer goes" error={fieldErrors.requester_email}><Input type="email" required value={form.email} onChange={set('email')} autoComplete="email" autoCapitalize="none" spellCheck={false} /></Field>
                <Field label="What is wrong" error={fieldErrors.subject}><Input value={form.help_subject} onChange={set('help_subject')} maxLength={200} placeholder={securityReport ? 'Security vulnerability report' : 'I cannot sign in'} /></Field>
                <Field label="What happened" hint="what you tried, and what it said" error={fieldErrors.body}><Textarea rows={4} required value={form.help_body} maxLength={8000} onChange={(e) => setForm((current) => ({ ...current, help_body: e.target.value }))} /></Field>
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={!form.email.trim() || !form.help_body.trim() || offline}><LifeBuoy className="h-4 w-4" /> Send request</Button>
              </form>
            )}

            {!gated && mode === 'reset' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitReset(); }}>
                {tokenInfo && !tokenInfo.valid && <div className="auth-notice error compact">This link is invalid, has expired, or was already used. Request a new one with “Forgot password”, or ask your leader to send your sign-in details again.</div>}
                {tokenInfo?.username && <Field label="Username" hint="yours to keep"><Input value={tokenInfo.username} readOnly autoComplete="username" spellCheck={false} className="mono" /></Field>}
                <Field label={tokenInfo?.purpose === 'sign_in' ? 'Password' : 'New password'} hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={fieldErrors.password}>{passwordInput}</Field>
                <PasswordMeter value={form.password} />
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={Boolean(passwordProblem(form.password)) || (tokenInfo && !tokenInfo.valid)}><KeyRound className="h-4 w-4" /> Set password and sign in</Button>
              </form>
            )}
          </div>

          <div className="auth-trustline">
            <a href={siteHref('/security')}><ShieldCheck /> How it is secured</a>
            <i />
            <a href={siteHref('/privacy')}>Privacy</a>
            <i />
            <span>Vantage v{VERSION}</span>
          </div>
        </section>
      </main>
      </div>
    </div>
  );
}
