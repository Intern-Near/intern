/** What just happened, pinned to the bottom of the window, with a cross to put it away once read. */
export function Notice({ error, done, onClose }: { error: string | null; done: string | null; onClose: () => void }) {
  if (!error && !done) return null;
  return (
    <p className={`notice ${error ? "notice-bad" : "notice-ok"}`} role={error ? "alert" : "status"}>
      <span>{error ?? done}</span>
      <button type="button" className="notice-x" aria-label="Dismiss this message" onClick={onClose}>
        ×
      </button>
    </p>
  );
}
