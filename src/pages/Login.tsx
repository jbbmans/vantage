import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Eye,
  EyeOff,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Mail,
  Moon,
  ShieldCheck,
  Sparkles,
  Sun,
  UserRound,
  WifiOff,
} from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import * as api from '@/lib/api';
import { keys } from '@/lib/queries';
import { passwordProblem, passwordStrength, MIN_PASSWORD_LENGTH } from '../../shared/password';
import { applyTheme, resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';
import { cn } from '@/lib/utils';
import { applySeo, clearPublicStructuredData } from '@/lib/seo';

type Mode = 'login' | 'mfa' | 'setup' | 'register' | 'forgot' | 'reset' | 'invite';

interface Status {
  needsSetup: boolean;
  requiresSetupToken: boolean;
  selfRegistration: boolean;
  emailEnabled: boolean;
  displayName: string;
  announcement: string;
  maintenance: boolean;
}

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

export default function Login({ serverError, onRetry }: { serverError: string | null; onRetry: () => void }) {
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
          : 'login'
  ));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({
    username: '', password: '', first_name: '', last_name: '', middle_initial: '', rank_id: '', mos: '', email: '', unit_name: '', unit_short_name: '', setup_token: '', code: '', identifier: '',
  });
  const [challenge, setChallenge] = useState('');
  const [tokenInfo, setTokenInfo] = useState<any>(null);
  const [theme, setTheme] = useState(() => resolveTheme(storedTheme()));

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
    // The application is not content. Sign-in, reset and invite carry noindex, and the public
    // page's FAQ/video structured data is dropped so it cannot follow a person in here.
    applySeo({
      title: 'Sign in | Vantage',
      description: 'Sign in to your Vantage deployment.',
      canonicalPath: '/login',
      indexable: false,
    });
    clearPublicStructuredData();

    api.setupStatus().then((s: Status) => {
      setStatus(s);
      if (s.needsSetup && mode === 'login') setMode('setup');
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

  const finish = () => {
    qc.invalidateQueries({ queryKey: keys.me });
    const authPath = ['/login', '/register', '/reset', '/invite', '/setup'].some((p) => path.startsWith(p));
    window.history.replaceState(null, '', authPath ? '/' : `${window.location.pathname}${window.location.search}`);
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
    toast.info(result.emailEnabled ? 'If that account has an email on file, a reset link is on its way.' : 'Email is not configured on this server. Ask your unit leader or the owner for a temporary password.');
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
    login: ['Welcome back', 'Sign in', 'Continue to your Vantage workspace.'],
    mfa: ['Secure sign-in', 'Second step', 'Enter the six-digit code from your authenticator app, or a recovery code.'],
    setup: ['First launch', 'Set up Vantage', 'Create the owner account and the first unit. This only happens once.'],
    register: ['Join Vantage', 'Create your account', 'Self-registration is open on this deployment.'],
    forgot: ['Account recovery', 'Reset your password', 'Enter your username or email. If email is configured, a one-time link follows.'],
    reset: ['Account recovery', 'Choose a new password', tokenInfo?.email ? `Resetting the account for ${tokenInfo.email}.` : 'This link works once and expires after 30 minutes.'],
    invite: ['Your invitation', 'Accept your invitation', tokenInfo?.unit ? `${tokenInfo.invitedBy || 'A leader'} invited you to ${tokenInfo.unit}.` : 'Create your account to join the unit.'],
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
      <div className="auth-grid" aria-hidden />
      <div className="auth-aura auth-aura-one" aria-hidden />
      <div className="auth-aura auth-aura-two" aria-hidden />
      <div className="auth-mountains" aria-hidden>
        <span className="mountain mountain-a" />
        <span className="mountain mountain-b" />
        <span className="mountain mountain-c" />
        <span className="mountain mountain-d" />
      </div>

      <header className="auth-topbar">
        <Link to="/" className="auth-top-brand" aria-label="Vantage overview">
          <img src="/mark.svg" alt="" />
          <span>VANTAGE</span>
        </Link>
        <div className="auth-top-actions">
          <Link to="/display" className="auth-overview-link">About Vantage <ArrowRight /></Link>
          <button type="button" onClick={toggleTheme} className="auth-theme" aria-label="Toggle theme">
            {theme === 'dark' ? <Sun /> : <Moon />}
          </button>
        </div>
      </header>

      <main className="auth-stage">
        <div className="auth-float auth-float-one" aria-hidden>
          <BarChart3 />
          <span><b>Performance</b><small>Action-first metrics</small></span>
        </div>
        <div className="auth-float auth-float-two" aria-hidden>
          <ShieldCheck />
          <span><b>Traceable</b><small>Source-linked records</small></span>
        </div>
        <div className="auth-float auth-float-three" aria-hidden>
          <Sparkles />
          <span><b>Vantage Assist</b><small>AI where work happens</small></span>
        </div>

        <section className="auth-shell" aria-labelledby="auth-heading">
          {/* An owner who sets an instance display name is told, in the owner console, that it shows
              on the sign-in page. Hard-coding the wordmark here quietly broke that promise for every
              custom-branded deployment, so the configured name wins and Vantage is the fallback. */}
          <div className="auth-brand-lockup">
            <div className="auth-mark-wrap"><img src="/mark.svg" alt="" /></div>
            <p>{status?.displayName && status.displayName !== 'Vantage' ? status.displayName : 'VANTAGE'}</p>
            <span>{status?.displayName && status.displayName !== 'Vantage' ? 'Powered by Vantage' : 'Performance · Productivity · Readiness'}</span>
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
            {status?.maintenance && <div className="auth-notice warn">Vantage is in maintenance. Only the owner can sign in right now.</div>}
            {(serverError || statusError) && (
              <div className="auth-notice error">
                <WifiOff /><span>{serverError || statusError}</span>
                <Button size="xs" onClick={() => { setStatusError(''); onRetry(); api.setupStatus().then(setStatus).catch((e) => setStatusError(api.errorText(e))); }}>Retry</Button>
              </div>
            )}
            {error && <div role="alert" className="auth-notice error compact">{error}</div>}

            {mode === 'login' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
                <Field label="Username" error={fieldErrors.username}>
                  <div className="auth-input-wrap" role="group" aria-label="Username controls"><UserRound /><Input aria-label="Username" autoFocus required autoComplete="username webauthn" spellCheck={false} autoCapitalize="none" value={form.username} onChange={set('username')} /></div>
                </Field>
                <Field label="Password" error={fieldErrors.password}>
                  <div className="auth-input-wrap" role="group" aria-label="Password field"><LockKeyhole />{passwordInput}</div>
                </Field>
                <div className="auth-form-links">
                  <button type="button" className="link" onClick={() => setMode('forgot')}>Forgot your password?</button>
                  {status?.selfRegistration && <button type="button" className="link" onClick={() => setMode('register')}>Create an account</button>}
                </div>
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={offline}>
                  Sign in <ArrowRight className="h-4 w-4" />
                </Button>
                <div className="auth-divider"><span>or continue with</span></div>
                <Button type="button" variant="outline" size="lg" className="auth-passkey" onClick={passkey} disabled={busy || offline}>
                  <Fingerprint className="h-4 w-4" /> Sign in with a passkey
                </Button>
              </form>
            )}

            {mode === 'mfa' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitMfa(); }}>
                <Field label="Code" hint="6 digits, or a recovery code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={form.code} onChange={set('code')} className="fig text-lg tracking-[0.3em]" /></Field>
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={form.code.replace(/\s/g, '').length < 6}><ShieldCheck className="h-4 w-4" /> Verify</Button>
              </form>
            )}

            {(mode === 'setup' || mode === 'register' || mode === 'invite') && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); (mode === 'setup' ? submitSetup : mode === 'register' ? submitRegister : submitInvite)(); }}>
                {mode === 'invite' && tokenInfo && !tokenInfo.valid && <div className="auth-notice error compact">This invitation is invalid or has expired. Ask your leader for a new one.</div>}
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
                {mode === 'setup' && (
                  <div className="auth-two-col auth-unit-fields">
                    <Field label="First unit" required hint="you will lead it" error={fieldErrors.unit_name}><Input value={form.unit_name} onChange={set('unit_name')} placeholder="Comptroller, MCB Quantico" /></Field>
                    <Field label="Short name" error={fieldErrors.unit_short_name}><Input value={form.unit_short_name} onChange={set('unit_short_name')} placeholder="G-8" /></Field>
                  </div>
                )}
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={Boolean(passwordProblem(form.password)) || !form.username || !form.first_name || !form.last_name || (mode === 'invite' && tokenInfo && !tokenInfo.valid)}>
                  {mode === 'setup' ? 'Create owner account' : mode === 'register' ? 'Create account' : 'Join and sign in'} <ArrowRight className="h-4 w-4" />
                </Button>
              </form>
            )}

            {mode === 'forgot' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitForgot(); }}>
                <Field label="Username or email"><Input autoFocus value={form.identifier} onChange={set('identifier')} autoCapitalize="none" /></Field>
                {status && !status.emailEnabled && <p className="text-xs text-ink-3">Email is not configured here. Your unit leader or the owner can issue a temporary password from the Team page instead.</p>}
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={!form.identifier}><Mail className="h-4 w-4" /> Send reset link</Button>
              </form>
            )}

            {mode === 'reset' && (
              <form className="auth-form" onSubmit={(e) => { e.preventDefault(); submitReset(); }}>
                {tokenInfo && !tokenInfo.valid && <div className="auth-notice error compact">This reset link is invalid or has expired. Request a new one.</div>}
                <Field label="New password" hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={fieldErrors.password}>{passwordInput}</Field>
                <PasswordMeter value={form.password} />
                <Button type="submit" variant="primary" size="lg" className="auth-submit" loading={busy} disabled={Boolean(passwordProblem(form.password)) || (tokenInfo && !tokenInfo.valid)}><KeyRound className="h-4 w-4" /> Set password and sign in</Button>
              </form>
            )}
          </div>

          <div className="auth-trustline">
            <span><ShieldCheck /> Secure workspace</span>
            <i />
            <span>Vantage v{VERSION}</span>
            <i />
            <span>Records stay on this deployment</span>
          </div>
        </section>
      </main>
    </div>
  );
}
