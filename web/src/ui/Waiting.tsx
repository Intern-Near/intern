import { Intern } from "../cast/Intern";

type Props = { error: string | null; line: string };

/** What a page shows before its first data arrives, or when the program cannot be reached at all. */
export function Waiting({ error, line }: Props) {
  if (!error) {
    return (
      <main className="loading" aria-busy="true">
        <Intern mood="thinking" size={200} />
        <p>{line}</p>
      </main>
    );
  }
  return (
    <main className="loading unreachable">
      <Intern mood="refused" size={200} />
      <h1>Can't reach the program.</h1>
      <p className="unreachable-text">
        The site asked the NEAR test network for the Intern's numbers and got no answer. Nothing was sent from your side and nothing is lost. It keeps trying every
        few seconds; you can also try again now.
      </p>
      <button className="btn" onClick={() => window.location.reload()}>
        Try again
      </button>
      <p className="mono unreachable-why">{error}</p>
    </main>
  );
}
