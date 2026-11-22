/**
 * Step-up from anywhere in the app: a change the server refuses with sudo_required asks the person to confirm it is them
 * (the dialog AppShell and ConsoleFrame show for this event), then runs once more. Calls made while the dialog is open
 * wait for the same answer.
 */
export interface SudoRequest { confirm: () => void; cancel: () => void }
const waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
const settle = (ok: boolean) => { const list = waiters.splice(0, waiters.length); for (const w of list) { if (ok) w.resolve(); else w.reject(new Error('Confirmation cancelled.')); } };

export async function withSudo<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'sudo_required') throw error;
    await new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
      if (waiters.length === 1) window.dispatchEvent(new CustomEvent<SudoRequest>('vantage:sudo-required', { detail: { confirm: () => settle(true), cancel: () => settle(false) } }));
    });
    return action();
  }
}
