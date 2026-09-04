export default function AppLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <img src="/mark.svg" alt="" width={48} height={48} className="h-12 w-12 animate-pulse" />
        <p className="text-sm text-ink-3">Loading Vantage…</p>
      </div>
    </div>
  );
}
