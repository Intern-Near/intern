import { useEffect, useState } from "react";
import { babbleTick } from "./sound";

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Props = { text: string; voice?: "intern" | "stamp"; speed?: number; onDone?: () => void; silent?: boolean };

/** Words that type themselves out, with babble while they do. Screen readers get the whole line at once. */
export function Typed({ text, voice = "intern", speed = 26, onDone, silent = false }: Props) {
  const [n, setN] = useState(() => (reduced() ? text.length : 0));

  useEffect(() => {
    if (reduced()) {
      onDone?.();
      return;
    }
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setN(i);
      if (!silent && i % 2 === 1 && text[i - 1] !== " ") babbleTick(voice, text.charCodeAt(i - 1));
      if (i >= text.length) {
        window.clearInterval(id);
        onDone?.();
      }
    }, speed);
    return () => window.clearInterval(id);
    // One run per mount. Callers remount with `key` to say a new line.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span>
      <span aria-hidden="true">{text.slice(0, n)}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
