import React, { useEffect, useState } from 'react';
import { BadgeCheck, KeyRound, Loader2, LockKeyhole, UserPlus } from 'lucide-react';
import { needsSetup, registerAccount, runSetup } from '@/lib/api';
import { signIn, signInWithCac } from '@/store/useStore';
import { Button, Input, Field } from '@/components/ui/primitives';

/**
 * Sign-in, and first-run setup when the database is empty.
 *
 * Setup only appears when there are genuinely no users. Once someone exists,
 * this endpoint is closed — an open bootstrap route is how a fresh deployment
 * gets an uninvited administrator.
 */
export default function Login() {
  const [mode, setMode] = useState('checking');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupTokenRequired, setSetupTokenRequired] = useState(false);
  const [capabilities, setCapabilities] = useState({
    selfRegistration: false, passwordEnabled: true, cacPivEnabled: false,
  });
  const [setupForm, setSetupForm] = useState({
    first_name: '', last_name: '', rank_id: 'Cpl', mos: '', email: '',
    unit_code: 'MFR', billet_title: 'Financial Management Resource Analyst', setup_token: '',
  });

  useEffect(() => {
    needsSetup()
      .then((r) => {
        try {
          if (!localStorage.getItem('vantage.theme')) {
            const defaultTheme = r.defaultTheme === 'dark' ? 'dark' : 'light';
            localStorage.setItem('vantage.theme', defaultTheme);
            document.documentElement.setAttribute('data-theme', defaultTheme);
          }
        } catch { /* the CSS default remains available */ }
        setSetupTokenRequired(Boolean(r.requiresSetupToken));
        setCapabilities({
          selfRegistration: Boolean(r.selfRegistration),
          passwordEnabled: r.passwordEnabled !== false,
          cacPivEnabled: Boolean(r.cacPivEnabled),
        });
        setMode(r.needsSetup ? 'setup' : 'login');
      })
      .catch(() => setMode('login'));
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    // Read credentials from the submitted form instead of trusting React state
    // alone. Password managers and secure browser handoffs can populate native
    // inputs without emitting the same sequence of events as a keyboard; the
    // submitted values are still present in FormData and must remain usable.
    const form = e?.currentTarget ? new FormData(e.currentTarget) : null;
    const submittedUsername = String(form?.get('username') || username).trim();
    const submittedPassword = String(form?.get('password') || password);
    setError('');
    if (!submittedUsername || !submittedPassword) {
      setError('Enter both your username and password.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'setup') {
        await runSetup({ username: submittedUsername, password: submittedPassword, ...setupForm });
      } else if (mode === 'register') {
        await registerAccount({ username: submittedUsername, password: submittedPassword, ...setupForm });
      }
      await signIn(submittedUsername, submittedPassword);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setSetupForm((f) => ({ ...f, [k]: e.target?.value ?? e }));

  const cacSignIn = async () => {
    setError('');
    setBusy(true);
    try { await signInWithCac(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-ink p-4 sm:p-8">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_35%_0%,rgba(39,118,210,0.16),transparent_58%)]" />
      <div className="relative grid w-full max-w-5xl overflow-hidden rounded-[1.4rem] border border-rule bg-panel shadow-[0_28px_80px_rgba(16,49,70,0.12)] lg:grid-cols-[1.05fr_0.95fr]">
        <section className="hidden min-h-[650px] flex-col justify-between bg-nav p-10 text-white lg:flex">
          <div>
            <img src="/mark.svg" alt="" className="h-10 w-10 brightness-0 invert" />
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.26em] text-white/55">Vantage</p>
            <h1 className="mt-3 max-w-sm text-4xl font-medium leading-[1.08] tracking-tight">Your work, made visible when it matters.</h1>
            <p className="mt-5 max-w-sm text-sm leading-6 text-white/68">
              Capture outcomes in seconds, understand the unit picture, and turn a year of real work into a credible career record.
            </p>
          </div>
          <div className="space-y-3 border-t border-white/12 pt-6 text-sm text-white/68">
            <p className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-[#7bc4ed]" /> Exact-unit access boundaries</p>
            <p className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-[#7bc4ed]" /> Audited protected record reads</p>
            <p className="text-xs leading-5 text-white/55">Controlled evaluation system. Verify authorization before entering real personnel information.</p>
          </div>
        </section>

      <form onSubmit={submit} className="flex min-h-[590px] flex-col justify-center p-6 sm:p-10 lg:min-h-[650px]">
        <div className="flex items-center gap-3 lg:hidden">
          <img src="/mark.svg" alt="" className="h-8 w-8" />
          <span className="text-sm font-semibold tracking-[0.18em] text-text">VANTAGE</span>
        </div>

        <p className="eyebrow mt-8 lg:mt-0">Secure performance workspace</p>
        <h2 className="mt-2 text-3xl font-medium tracking-tight text-text">
          {mode === 'setup' ? 'Set up this command' : mode === 'register' ? 'Create your account' : 'Welcome back'}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-text-3">
          {mode === 'setup'
            ? 'No accounts exist yet. This creates the first Unit Owner and local recovery account.'
            : mode === 'register'
              ? 'Your account starts personal-only. You will see no unit information until an authorized leader attaches you.'
              : 'Sign in to your personal record and authorized unit workspace.'}
        </p>

        {mode !== 'setup' && capabilities.selfRegistration && capabilities.passwordEnabled && (
          <div className="mt-5 grid grid-cols-2 rounded-lg bg-panel-2 p-1" role="tablist" aria-label="Account access">
            <button type="button" role="tab" aria-selected={mode === 'login'} onClick={() => { setMode('login'); setError(''); }}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${mode === 'login' ? 'bg-panel text-text shadow-sm' : 'text-text-3 hover:text-text'}`}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'register'} onClick={() => { setMode('register'); setError(''); }}
              className={`rounded-md px-3 py-2 text-sm font-medium transition ${mode === 'register' ? 'bg-panel text-text shadow-sm' : 'text-text-3 hover:text-text'}`}>
              Create account
            </button>
          </div>
        )}

        <div className="mt-4 space-y-3">
          <Field label="Username">
            <Input name="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Field label="Password" hint={mode === 'setup' || mode === 'register' ? '15 characters minimum — use a unique passphrase' : undefined}>
            <Input
              type="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>

          {(mode === 'setup' || mode === 'register') && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <Input value={setupForm.first_name} onChange={set('first_name')} />
                </Field>
                <Field label="Last name">
                  <Input value={setupForm.last_name} onChange={set('last_name')} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Rank">
                  <Input value={setupForm.rank_id} onChange={set('rank_id')} placeholder="Cpl" />
                </Field>
                <Field label="MOS">
                  <Input value={setupForm.mos} onChange={set('mos')} placeholder="3451" />
                </Field>
              </div>
              {mode === 'setup' && (
                <Field label="Unit code" hint="The first owner is attached here; later accounts start unattached">
                  <Input value={setupForm.unit_code} onChange={set('unit_code')} />
                </Field>
              )}
              {mode === 'register' && (
                <Field label="Email" hint="Optional; not used for sign-in">
                  <Input type="email" value={setupForm.email} onChange={set('email')} autoComplete="email" />
                </Field>
              )}
              {mode === 'setup' && setupTokenRequired && (
                <Field label="Deployment setup token" hint="Provided by the person who configured the server">
                  <Input type="password" value={setupForm.setup_token} onChange={set('setup_token')} autoComplete="off" />
                </Field>
              )}
            </>
          )}
        </div>

        {error && <p className="mt-3 text-xs leading-relaxed text-redline" role="alert">{error}</p>}

        <Button
          type="submit"
          variant="primary"
          size="md"
          className="mt-4 w-full justify-center"
          disabled={busy || mode === 'checking'
            || ((mode === 'setup' || mode === 'register') && (!setupForm.first_name || !setupForm.last_name))
            || (mode === 'setup' && setupTokenRequired && !setupForm.setup_token)}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : mode === 'register' ? <UserPlus className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />}
          {mode === 'setup' ? 'Create Unit Leader and sign in' : mode === 'register' ? 'Create personal account' : 'Sign in'}
        </Button>

        {mode === 'login' && capabilities.cacPivEnabled && (
          <Button type="button" size="md" className="mt-2 w-full justify-center" disabled={busy} onClick={cacSignIn}>
            <BadgeCheck className="h-4 w-4" /> Sign in with CAC/PIV
          </Button>
        )}

        <p className="fig mt-4 border-t border-rule pt-3 text-2xs leading-relaxed text-text-3">
          VANTAGE · BUILT BY JOHN BERNARD BOLETZ · US REGION
          <br />RECORDS STAY ON THIS DEPLOYMENT. NO EXTERNAL GENERATIVE AI.
        </p>
      </form>
      </div>
    </div>
  );
}
