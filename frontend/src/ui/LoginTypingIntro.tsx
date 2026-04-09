import { useEffect, useMemo, useState } from "react";

const MAIN_LINE = "Hey, I am Albus — welcome to the trading universe.";

/** Curated quotes; one `{ quote, author }` pair picked at random on each full page load. */
const TRADING_QUOTES: ReadonlyArray<{ quote: string; author: string }> = [
  {
    quote: "Rule No. 1: Never lose money. Rule No. 2: Never forget rule No. 1.",
    author: "Warren Buffett",
  },
  {
    quote:
      "In the short run, the market is a voting machine, but in the long run it becomes a weighing machine.",
    author: "Benjamin Graham",
  },
  {
    quote:
      "The speculator's chief enemies are always boring from within: hope and fear mingle in his mind — hope when a profit shows itself, fear when loss threatens.",
    author: "Jesse Livermore",
  },
  {
    quote: "I'm only rich because I know when I'm wrong. I basically have survived by recognizing my mistakes.",
    author: "George Soros",
  },
  {
    quote: "Losers average losers.",
    author: "Paul Tudor Jones",
  },
  {
    quote:
      "The secret to being successful from a trading perspective is to have an indefatigable and an undying and unquenchable thirst for information and knowledge.",
    author: "Paul Tudor Jones",
  },
  {
    quote:
      "It takes tremendous discipline to stay patient, wait for the fat pitch, and then execute with conviction when everyone else is zigging.",
    author: "Stanley Druckenmiller",
  },
  {
    quote:
      "Learn to take losses. The most important thing in making money is not letting your losses get out of hand — protect the downside and the upside takes care of itself.",
    author: "Marty Schwartz",
  },
  {
    quote: "Pain plus reflection equals progress.",
    author: "Ray Dalio",
  },
  {
    quote:
      "Win or lose, everybody gets what they want out of the market. Some people seem to like to lose, so they win by losing money.",
    author: "Ed Seykota",
  },
  {
    quote: "The big money is not in the buying and the selling, but in the waiting.",
    author: "Charlie Munger",
  },
  {
    quote: "Know what you own, and know why you own it.",
    author: "Peter Lynch",
  },
  {
    quote: "The four most dangerous words in investing are: This time it's different.",
    author: "John Templeton",
  },
  {
    quote:
      "The goal of a successful trader is to make the best trades. Money is secondary. If you focus on the process, the outcomes tend to follow.",
    author: "Alexander Elder",
  },
  {
    quote:
      "Risk comes from not knowing what you're doing. When you understand your edge and size accordingly, the market becomes a tool, not a casino.",
    author: "Warren Buffett",
  },
  {
    quote: "Time is your friend; impulse is your enemy. Take advantage of compound interest — and don't get subverted by it.",
    author: "John C. Bogle",
  },
  {
    quote:
      "Every minute you spend wishing you had started earlier is a minute you're not learning from what's in front of you right now.",
    author: "Linda Raschke",
  },
  {
    quote:
      "The market rewards those who respect its uncertainty. Ego is expensive; humility and a journal are free.",
    author: "Mark Douglas",
  },
  {
    quote:
      "Cut losses quickly. Let winners run. The rest is noise, discipline, and showing up the same way on winning days and losing days.",
    author: "William J. O'Neil",
  },
  {
    quote:
      "What separates the lasting participants from the crowd isn't a secret indicator — it's capital preservation, patience, and the courage to act small when conviction is low.",
    author: "Jim Simons",
  },
];

const CHAR_MS_MAIN = 40;
const CHAR_MS_QUOTE = 32;
const CHAR_MS_AUTHOR = 28;
const GAP_AFTER_MAIN_MS = 320;
const GAP_AFTER_QUOTE_MS = 240;

type Stage =
  | "typing_main"
  | "gap"
  | "typing_quote"
  | "gap_quote"
  | "typing_author"
  | "done";

function BlinkCursor({ blink }: { blink: boolean }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    if (!blink) {
      setOn(true);
      return;
    }
    const t = window.setInterval(() => setOn((v) => !v), 520);
    return () => window.clearInterval(t);
  }, [blink]);
  return (
    <span
      className={`ml-0.5 inline-block min-w-[0.55ch] font-mono font-normal text-sky-600 tabular-nums transition-opacity duration-75 dark:text-sky-400 ${
        blink ? (on ? "opacity-100" : "opacity-0") : "opacity-100"
      }`}
      aria-hidden
    >
      _
    </span>
  );
}

/**
 * Types the welcome line, then a random trading quote and its attribution; blinking cursor at the active end.
 */
export function LoginTypingIntro() {
  const entry = useMemo(() => TRADING_QUOTES[Math.floor(Math.random() * TRADING_QUOTES.length)], []);
  const authorLine = `by ${entry.author}`;

  const [mainLen, setMainLen] = useState(0);
  const [quoteLen, setQuoteLen] = useState(0);
  const [authorLen, setAuthorLen] = useState(0);
  const [stage, setStage] = useState<Stage>("typing_main");

  useEffect(() => {
    let cancelled = false;
    const timeouts: number[] = [];
    const schedule = (fn: () => void, ms: number) => {
      timeouts.push(window.setTimeout(fn, ms));
    };

    let mainI = 0;
    const tickMain = () => {
      if (cancelled) return;
      if (mainI < MAIN_LINE.length) {
        mainI += 1;
        setMainLen(mainI);
        schedule(tickMain, CHAR_MS_MAIN);
      } else {
        setStage("gap");
        schedule(() => {
          if (cancelled) return;
          setStage("typing_quote");
          let qI = 0;
          const tickQuote = () => {
            if (cancelled) return;
            if (qI < entry.quote.length) {
              qI += 1;
              setQuoteLen(qI);
              schedule(tickQuote, CHAR_MS_QUOTE);
            } else {
              setStage("gap_quote");
              schedule(() => {
                if (cancelled) return;
                setStage("typing_author");
                let aI = 0;
                const tickAuthor = () => {
                  if (cancelled) return;
                  if (aI < authorLine.length) {
                    aI += 1;
                    setAuthorLen(aI);
                    schedule(tickAuthor, CHAR_MS_AUTHOR);
                  } else {
                    setStage("done");
                  }
                };
                tickAuthor();
              }, GAP_AFTER_QUOTE_MS);
            }
          };
          tickQuote();
        }, GAP_AFTER_MAIN_MS);
      }
    };

    tickMain();

    return () => {
      cancelled = true;
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, [entry.quote, authorLine]);

  const mainVisible = MAIN_LINE.slice(0, mainLen);
  const quoteVisible = entry.quote.slice(0, quoteLen);
  const authorVisible = authorLine.slice(0, authorLen);

  const showQuoteBlock = stage !== "typing_main" && stage !== "gap";
  const cursorOnMain = stage === "typing_main" || stage === "gap";
  const cursorOnQuote = stage === "typing_quote" || stage === "gap_quote";
  const cursorOnAuthor = stage === "typing_author" || stage === "done";

  return (
    <div className="max-w-md px-1 sm:max-w-lg">
      <p className="text-2xl font-semibold leading-snug text-slate-900 dark:text-slate-100 sm:text-3xl">
        {mainVisible}
        {cursorOnMain ? <BlinkCursor blink={stage === "gap"} /> : null}
      </p>
      {showQuoteBlock ? (
        <>
          <p className="mt-4 min-h-[1.5rem] text-sm font-medium leading-relaxed text-slate-700 dark:text-slate-300 sm:text-base">
            {quoteVisible}
            {cursorOnQuote ? <BlinkCursor blink={stage === "gap_quote"} /> : null}
          </p>
          {(stage === "typing_author" || stage === "done" || authorLen > 0) && (
            <p className="mt-3 min-h-[1.25rem] text-xs font-medium tracking-wide text-slate-500 dark:text-slate-400 sm:text-sm">
              {authorVisible}
              {cursorOnAuthor ? <BlinkCursor blink={stage === "done"} /> : null}
            </p>
          )}
        </>
      ) : null}
    </div>
  );
}
