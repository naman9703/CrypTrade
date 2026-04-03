export { isIncomeLedgerClose } from "./tradeClassification";

function playSrc(src: string) {
  try {
    const a = new Audio(src);
    void a.play().catch(() => {});
  } catch {
    /* autoplay or missing file */
  }
}

/** Served from repo `public/media` via Vite `publicDir`. */
export function playEngineStartSound() {
  playSrc("/media/engine-start.mp3");
}

export function playProfitCloseSound() {
  playSrc("/media/money-sound.mp3");
}
