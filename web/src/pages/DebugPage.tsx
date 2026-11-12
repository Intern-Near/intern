import "./foundations.css";
import { useDesk } from "../chain/store";
import { SCENES } from "../chain/types";

/** Step 2 page: prints what every view returns, for the source and scene in the address bar. */
export function DebugPage() {
  const snap = useDesk();
  return (
    <main className="foundations">
      <header>
        <p className="mono">STEP 2 · DATA LAYER · SOURCE {snap.source.toUpperCase()} · SCENE {snap.scene ?? "-"}</p>
        <h1>What the program says.</h1>
        <p className="row">
          {SCENES.map((s) => (
            <a key={s} href={`?page=debug&scene=${s}`}>
              {s}
            </a>
          ))}
        </p>
      </header>
      {snap.error && <p role="alert">{snap.error}</p>}
      <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        {JSON.stringify({ fresh: snap.fresh, ...snap.desk, constants: "(omitted)" }, null, 1)}
      </pre>
    </main>
  );
}
