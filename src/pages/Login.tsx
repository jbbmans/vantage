import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startAuthentication } from '@simplewebauthn/browser';
import { KeyRound, ShieldCheck, Fingerprint, Mail, ArrowLeft, WifiOff, Sun, Moon } from 'lucide-react';
import { Button, Field, Input, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import * as api from '@/lib/api';
import { keys } from '@/lib/queries';
import { passwordProblem, passwordStrength, MIN_PASSWORD_LENGTH } from '../../shared/password';
import { applyTheme, resolveTheme, storedTheme } from '@/lib/theme';
import { VERSION } from '@/lib/version';
import { cn } from '@/lib/utils';

type Mode = 'login' | 'mfa' | 'setup' | 'register' | 'forgot' | 'reset' | 'invite';

interface Status { needsSetup: boolean; requiresSetupToken: boolean; selfRegistration: boolean; emailEnabled: boolean; displayName: string; announcement: string; maintenance: boolean }

function useRanks() {
  const [ranks, setRanks] = useState<Array<{ id: string; abbr: string; name: string }>>([]);
  useEffect(() => { api.api.get('/ranks').then((r) => setRanks(Array.isArray(r) ? r : [])).catch(() => setRanks([])); }, []);
  return ranks;
}

function PasswordMeter({ value }: { value: string }) {
  if (!value) return null;
  const s = passwordStrength(value);
  const problem = passwordProblem(value);
  return (
    <div className="mt-1.5">
      <div className="flex gap-1">{[0, 1, 2, 3].map((i) => <span key={i} className={cn('h-1 flex-1 rounded-full', i < s.score ? (s.score >= 3 ? 'bg-good' : s.score === 2 ? 'bg-warn' : 'bg-bad') : 'bg-surface-3')} />)}</div>
      <p className={cn('mt-1 text-2xs', problem ? 'text-ink-3' : 'text-good')}>{problem || `${s.label}. Long and memorable beats short and clever.`}</p>
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
  const [mode, setMode] = useState<Mode>(() => (path.startsWith('/reset') && params.get('token') ? 'reset' : path.startsWith('/invite') && params.get('token') ? 'invite' : path.startsWith('/register') ? 'register' : 'login'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Record<string, string>>({ username: '', password: '', first_name: '', last_name: '', middle_initial: '', rank_id: '', mos: '', email: '', unit_name: '', unit_short_name: '', setup_token: '', code: '', identifier: '' });
  const [challenge, setChallenge] = useState('');
  const [tokenInfo, setTokenInfo] = useState<any>(null);
  const [theme, setTheme] = useState(() => resolveTheme(storedTheme()));
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => { setForm((f) => ({ ...f, [k]: e.target.value })); setFieldErrors((fe) => { if (!fe[k]) return fe; const n = { ...fe }; delete n[k]; return n; }); };

  useEffect(() => {
    api.setupStatus().then((s: Status) => { setStatus(s); if (s.needsSetup && mode === 'login') setMode('setup'); }).catch((e) => setStatusError(api.errorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const token = params.get('token') || '';
    if (mode === 'reset' && token) api.resetStatus(token).then(setTokenInfo).catch(() => setTokenInfo({ valid: false }));
    if (mode === 'invite' && token) api.inviteStatus(token).then((info) => { setTokenInfo(info); if (info?.suggested) setForm((f) => ({ ...f, first_name: info.suggested.first_name || '', last_name: info.suggested.last_name || '', rank_id: info.suggested.rank_id || '', email: info.email || '' })); }).catch(() => setTokenInfo({ valid: false }));
  }, [mode, params]);

  const finish = () => {
    qc.invalidateQueries({ queryKey: keys.me });
    const authPath = ['/login', '/register', '/reset', '/invite', '/setup'].some((p) => path.startsWith(p));
    window.history.replaceState(null, '', authPath ? '/' : `${window.location.pathname}${window.location.search}`);
  };
  const fail = (e: unknown) => { const err = e as api.ApiError; setError(err.fieldErrors && Object.keys(err.fieldErrors).length ? 'Check the highlighted fields.' : api.errorText(e)); setFieldErrors(err.fieldErrors || {}); };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); setFieldErrors({}); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };

  const submitLogin = () => run(async () => {
    const r = await api.login(form.username, form.password);
    if (r.ok) finish(); else if (r.mfa === 'totp') { setChallenge(r.challenge); setMode('mfa'); }
  });
  const submitMfa = () => run(async () => { await api.loginMfa(challenge, form.code); finish(); });
  const submitSetup = () => run(async () => { await api.runSetup({ ...form, email: form.email || null, rank_id: form.rank_id || null, mos: form.mos || null, middle_initial: form.middle_initial || null, unit_short_name: form.unit_short_name || null }); finish(); });
  const submitRegister = () => run(async () => { await api.register({ username: form.username, password: form.password, first_name: form.first_name, last_name: form.last_name, middle_initial: form.middle_initial || null, rank_id: form.rank_id || null, mos: form.mos || null, email: form.email || null }); finish(); });
  const submitForgot = () => run(async () => { const r = await api.forgotPassword(form.identifier); toast.info(r.emailEnabled ? 'If that account has an email on file, a reset link is on its way.' : 'Email is not configured on this server. Ask your unit leader or the owner for a temporary password.'); setMode('login'); });
  const submitReset = () => run(async () => { const r = await api.resetPassword(params.get('token') || '', form.password); if (r?.mfa === 'totp') { setChallenge(r.challenge); setMode('mfa'); } else finish(); });
  const submitInvite = () => run(async () => { await api.acceptInvite({ token: params.get('token') || '', username: form.username, password: form.password, first_name: form.first_name, last_name: form.last_name, rank_id: form.rank_id || null, mos: form.mos || null, email: form.email || undefined }); finish(); });
  const passkey = () => run(async () => {
    const { options, key } = await api.passkeyOptions(form.username || undefined);
    let response;
    try { response = await startAuthentication({ optionsJSON: options }); }
    catch (e) { throw new Error((e as Error).name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : (e as Error).message); }
    await api.passkeyVerify(key, response);
    finish();
  });

  const toggleTheme = () => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); applyTheme(next); };
  const rankOptions = [{ value: '__none', label: 'No rank yet' }, ...ranks.map((r) => ({ value: r.id, label: `${r.abbr} · ${r.name}` }))];
  const RankSelect = <Select aria-label="Rank" value={form.rank_id || '__none'} onValueChange={(v) => setForm((f) => ({ ...f, rank_id: v === '__none' ? '' : v }))} options={rankOptions} />;
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  const heading: Record<Mode, [string, string]> = {
    login: ['Sign in', 'Your performance record, on your terms.'],
    mfa: ['Second step', 'Enter the six-digit code from your authenticator app, or a recovery code.'],
    setup: ['Set up Vantage', 'Create the owner account and the first unit. This only happens once.'],
    register: ['Create your account', 'Self-registration is open on this deployment.'],
    forgot: ['Reset your password', 'Enter your username or email. If email is configured, a one-time link follows.'],
    reset: ['Choose a new password', tokenInfo?.email ? `Resetting the account for ${tokenInfo.email}.` : 'This link works once and expires after 30 minutes.'],
    invite: ['Accept your invitation', tokenInfo?.unit ? `${tokenInfo.invitedBy || 'A leader'} invited you to ${tokenInfo.unit}.` : 'Create your account to join the unit.'],
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-accent-soft to-transparent" aria-hidden />
      <header className="relative z-10 flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3"><img src="/mark.svg" alt="" width={36} height={36} className="h-9 w-9 rounded-lg" /><div><p className="text-sm font-bold tracking-[0.16em] text-ink">VANTAGE</p><p className="text-2xs text-ink-3">{status?.displayName && status.displayName !== 'Vantage' ? status.displayName : 'Performance records for Marines'}</p></div></div>
        <button type="button" onClick={toggleTheme} className="rounded-md p-2 text-ink-2 hover:bg-surface-2" aria-label="Toggle theme">{theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}</button>
      </header>
      <main className="relative z-10 flex flex-1 items-start justify-center px-4 pb-16 pt-6 sm:pt-12">
        <div className="w-full max-w-md">
          {status?.announcement && <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-ink">{status.announcement}</div>}
          {status?.maintenance && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">Vantage is in maintenance. Only the owner can sign in right now.</div>}
          {(serverError || statusError) && <div className="mb-4 flex items-start gap-2 rounded-lg border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-ink"><WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-bad" /><span className="flex-1">{serverError || statusError}</span><Button size="xs" onClick={() => { setStatusError(''); onRetry(); api.setupStatus().then(setStatus).catch((e) => setStatusError(api.errorText(e))); }}>Retry</Button></div>}
          <div className="card p-6 sm:p-8">
            {mode !== 'login' && mode !== 'setup' && <button type="button" onClick={() => { setMode('login'); setError(''); }} className="mb-4 flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />Back to sign in</button>}
            <h1 className="text-xl font-semibold text-ink">{heading[mode][0]}</h1>
            <p className="mt-1 text-sm text-ink-3">{heading[mode][1]}</p>
            {error && <p role="alert" className="mt-4 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad">{error}</p>}

            {mode === 'login' && (
              <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); submitLogin(); }}>
                <Field label="Username" error={fieldErrors.username}><Input autoFocus autoComplete="username webauthn" spellCheck={false} autoCapitalize="none" value={form.username} onChange={set('username')} /></Field>
                <Field label="Password" error={fieldErrors.password}><Input type="password" autoComplete="current-password" value={form.password} onChange={set('password')} /></Field>
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={offline || !form.username || !form.password}>Sign in</Button>
                <Button type="button" variant="outline" size="lg" className="w-full" onClick={passkey} disabled={busy || offline}><Fingerprint className="h-4 w-4" />Sign in with a passkey</Button>
                <div className="flex flex-wrap justify-between gap-2 pt-1 text-xs">
                  <button type="button" className="link" onClick={() => setMode('forgot')}>Forgot your password?</button>
                  {status?.selfRegistration && <button type="button" className="link" onClick={() => setMode('register')}>Create an account</button>}
                </div>
              </form>
            )}

            {mode === 'mfa' && (
              <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); submitMfa(); }}>
                <Field label="Code" hint="6 digits, or a recovery code"><Input autoFocus inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={form.code} onChange={set('code')} className="fig text-lg tracking-[0.3em]" /></Field>
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={form.code.replace(/\s/g, '').length < 6}><ShieldCheck className="h-4 w-4" />Verify</Button>
              </form>
            )}

            {(mode === 'setup' || mode === 'register' || mode === 'invite') && (
              <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); (mode === 'setup' ? submitSetup : mode === 'register' ? submitRegister : submitInvite)(); }}>
                {mode === 'invite' && tokenInfo && !tokenInfo.valid && <p className="rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad">This invitation is invalid or has expired. Ask your leader for a new one.</p>}
                {mode === 'setup' && status?.requiresSetupToken && <Field label="Deployment setup token" hint="from the server environment" error={fieldErrors.setup_token}><Input autoFocus value={form.setup_token} onChange={set('setup_token')} autoComplete="off" /></Field>}
                <div className="grid grid-cols-2 gap-3">
                  <Field label="First name" required error={fieldErrors.first_name}><Input value={form.first_name} onChange={set('first_name')} autoComplete="given-name" /></Field>
                  <Field label="Last name" required error={fieldErrors.last_name}><Input value={form.last_name} onChange={set('last_name')} autoComplete="family-name" /></Field>
                  <Field label="Rank" error={fieldErrors.rank_id}>{RankSelect}</Field>
                  <Field label="MOS" error={fieldErrors.mos}><Input value={form.mos} onChange={set('mos')} placeholder="3451" /></Field>
                </div>
                <Field label="Username" required hint="letters, numbers, dot, dash, underscore" error={fieldErrors.username}><Input value={form.username} onChange={set('username')} autoComplete="username" autoCapitalize="none" spellCheck={false} /></Field>
                <Field label="Email" hint={mode === 'invite' && tokenInfo?.email ? 'set by the invitation' : 'optional; used for reset links and the weekly digest'} error={fieldErrors.email}><Input type="email" spellCheck={false} value={form.email} onChange={set('email')} autoComplete="email" disabled={mode === 'invite' && Boolean(tokenInfo?.email)} /></Field>
                <Field label="Password" required hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={fieldErrors.password}><Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" /></Field>
                <PasswordMeter value={form.password} />
                {mode === 'setup' && (
                  <div className="grid grid-cols-[2fr_1fr] gap-3 border-t border-line pt-3">
                    <Field label="First unit" required hint="you will lead it" error={fieldErrors.unit_name}><Input value={form.unit_name} onChange={set('unit_name')} placeholder="Comptroller, MCB Quantico" /></Field>
                    <Field label="Short name" error={fieldErrors.unit_short_name}><Input value={form.unit_short_name} onChange={set('unit_short_name')} placeholder="G-8" /></Field>
                  </div>
                )}
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={Boolean(passwordProblem(form.password)) || !form.username || !form.first_name || !form.last_name || (mode === 'invite' && tokenInfo && !tokenInfo.valid)}>
                  {mode === 'setup' ? 'Create owner account' : mode === 'register' ? 'Create account' : 'Join and sign in'}
                </Button>
              </form>
            )}

            {mode === 'forgot' && (
              <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); submitForgot(); }}>
                <Field label="Username or email"><Input autoFocus value={form.identifier} onChange={set('identifier')} autoCapitalize="none" /></Field>
                {status && !status.emailEnabled && <p className="text-xs text-ink-3">Email is not configured here. Your unit leader or the owner can issue a temporary password from the Team page instead.</p>}
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={!form.identifier}><Mail className="h-4 w-4" />Send reset link</Button>
              </form>
            )}

            {mode === 'reset' && (
              <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); submitReset(); }}>
                {tokenInfo && !tokenInfo.valid && <p className="rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad">This reset link is invalid or has expired. Request a new one.</p>}
                <Field label="New password" hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={fieldErrors.password}><Input type="password" autoFocus value={form.password} onChange={set('password')} autoComplete="new-password" /></Field>
                <PasswordMeter value={form.password} />
                <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} disabled={Boolean(passwordProblem(form.password)) || (tokenInfo && !tokenInfo.valid)}><KeyRound className="h-4 w-4" />Set password and sign in</Button>
              </form>
            )}
          </div>
          <p className="mt-6 text-center text-2xs text-ink-3">Vantage v{VERSION}. Records stay on this deployment's server. Nothing here is a system of record; MOL is.</p>
        </div>
      </main>
    </div>
  );
}
