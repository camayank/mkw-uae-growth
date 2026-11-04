/**
 * The malware scanner, behind one interface (E22, CLAUDE.md rule 7). There is no live scanner yet: which one, and its
 * cost, is the owner's decision T6 (`docs/transformation/DECISION-LOG.md`). Until then:
 *   memoryScanner()   the test double. It finds the EICAR antivirus test file and nothing else, so it is NOT a malware
 *                     scan; the screens say so. Development, the demo and the tests use it.
 *   no scanner        (null) every upload is held until a scanner is configured, or, if the owner chooses it under
 *                     T6, served labelled "not scanned" (UPLOADS_UNSCANNED=allow).
 * A live adapter (a ClamAV daemon, or a managed service) implements the same interface.
 */
export interface ScanResult {
  verdict: "clean" | "infected";
  /** What was found, for an infected file. */
  finding?: string;
}

export interface Scanner {
  /** Shown on the System page and stored with each result. */
  readonly name: string;
  /** False for a test double: its "clean" says nothing about malware. */
  readonly live: boolean;
  /** Clean or infected; throws when the scan could not be done (a failed scan never counts as clean). */
  scan(data: Buffer): Promise<ScanResult>;
}

/**
 * The EICAR test file: a harmless string every antivirus product reports as a virus, so a scanner can be tested
 * without malware. Built at run time so that this source file is not itself reported.
 */
export function eicar(): string {
  return ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-", "TEST-FILE!$H+H*"].join("");
}

export interface MemoryScanner extends Scanner {
  /** While true, every scan throws, as an unreachable scanner would. */
  failing: boolean;
  scanned: number;
}

export function memoryScanner(): MemoryScanner {
  const signature = Buffer.from(eicar(), "latin1");
  const s: MemoryScanner = {
    name: "memory (test double, not a malware scan)",
    live: false,
    failing: false,
    scanned: 0,
    async scan(data) {
      s.scanned += 1;
      if (s.failing) throw new Error("The scanner did not answer");
      return data.includes(signature) ? { verdict: "infected", finding: "EICAR-Test-File" } : { verdict: "clean" };
    },
  };
  return s;
}

/**
 * The scanner from the environment. `SCANNER=memory` is the test double, refused in production because its "clean"
 * means nothing there; unset, there is no scanner and uploads are held (T6).
 */
export function scannerFromEnv(env: NodeJS.ProcessEnv = process.env): Scanner | null {
  const kind = env.SCANNER ?? "";
  if (kind === "") return null;
  if (kind === "memory") {
    if (env.NODE_ENV === "production") throw new Error("SCANNER=memory is a test double and cannot run in production: leave SCANNER unset until a live scanner is chosen (T6)");
    return memoryScanner();
  }
  throw new Error(`Unknown SCANNER "${kind}": only "memory" (development) exists until the owner chooses a live scanner (T6)`);
}

/** Give up on a scan after this long: a scanner that hangs must not hold a request open, and the file stays held. */
export const SCAN_TIMEOUT_MS = 20_000;

export async function scanWithin(scanner: Scanner, data: Buffer, ms = SCAN_TIMEOUT_MS): Promise<ScanResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      scanner.scan(data),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`The scan took longer than ${Math.round(ms / 1000)} seconds`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
