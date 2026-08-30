// scripts/model/regular-file.mjs — BLZ-493 / ADR-0031.
//
// `readFileSync` opens whatever the path names. On a FIFO with no writer that OPEN BLOCKS
// FOREVER: no error, no timeout, no exit, and `node:test`'s `timeout` option cannot rescue it
// because that timer lives on an event loop a synchronous read never yields to. Ten such
// reads sat on the path `blaze audit`, `buildIndex`, id resolution, the board view,
// `reconcile` and the long-lived `blaze serve` all share, so one `mkfifo` wedged every reader
// on the board with nothing on stderr.
//
// ADR-0030 §4 established the rule for the first of them — never open an entry that is not a
// regular file — and implemented it as `statSync` then open. THAT SHAPE IS NOT ENOUGH HERE.
// A stat on a PATH answers about the file that was there a moment ago; the process then opens
// the file that is there now. Losing that race is not a wrong answer, it is an unbounded hang,
// and one of the ten sites (`views/panel-content.mjs`) is reachable ONLY through a race of
// exactly this shape — the window `serve.mjs` already documents between the index walk and
// the panel's re-read. So the type is read from the OPEN FILE DESCRIPTOR:
//
//   1. `O_NONBLOCK` on the open, which is what makes opening a FIFO return instead of block.
//      Measured: 0ms on a FIFO with no writer. On a regular file it is a no-op.
//   2. `fstatSync(fd)` — the type of the file that is actually open, not of a path.
//   3. read, or refuse. Nothing between the check and the read can be swapped.
//
// A socket never reaches step 2: `open` on a Unix socket fails ENXIO immediately. A device
// node does, and is refused there — `/dev/null` returns zero bytes instantly rather than
// hanging, and a run that silently accepted that would read an empty config as a config,
// which is this programme's whole defect class by a quieter route.
//
// ENOENT IS DELIBERATELY UNTOUCHED. Callers here distinguish "there is no such file" (an
// answer: no config, no sprints, no cutover) from "there is something and I could not read
// it" (not an answer). Folding the two together would turn every board without an optional
// file into a hard failure — the mirror image of the bug.
import { openSync, fstatSync, closeSync, readFileSync, writeFileSync, appendFileSync, constants } from "node:fs";

// O_NONBLOCK is POSIX; `constants` omits it on platforms that have no such flag, where an
// open cannot block on a FIFO either. `|| 0` keeps the call valid there rather than NaN.
const NONBLOCK = constants.O_NONBLOCK || 0;

/** Thrown when a path names something Blaze will not read or write as a file.
 *  `code` is a named string rather than an errno so a caller can tell it from ENOENT/EACCES
 *  without matching on a message. */
export class NotARegularFileError extends Error {
  constructor(path, kind, verb = "read") {
    super(`blaze: ${path} is ${kind}, not a regular file — Blaze will not ${verb} it. ` +
      `Opening a FIFO with no peer blocks forever (no error, no timeout, no exit) and a ` +
      `device node answers instantly with bytes that are not the file's, so a run that ` +
      `accepted either would report on a corpus it never read. Replace the path with a ` +
      `regular file, or remove it.`);
    this.name = "NotARegularFileError";
    this.code = "ERR_BLAZE_NOT_A_REGULAR_FILE";
    this.path = path;
    this.kind = kind;
  }
}

/** Name the type in the words an operator would use to go and look at it.
 *
 *  REACHABILITY, measured rather than assumed. `isFIFO`, `isDirectory` and
 *  `isCharacterDevice` are all reached by tests. `isSocket` IS NOT AND CANNOT BE from either
 *  caller here: `open` on a Unix socket fails ENXIO before `fstat` is reached, for reading and
 *  for writing alike. It is kept as a label rather than deleted — the alternative is a socket
 *  on some future platform being named "an entry of an unrecognised type" — and it is written
 *  down here as unreachable instead of being left to look pinned. */
function kindOf(info) {
  if (info.isDirectory()) return "a directory";
  if (info.isFIFO()) return "a FIFO (a named pipe)";
  if (info.isSocket()) return "a socket";
  if (info.isCharacterDevice()) return "a character device node";
  if (info.isBlockDevice()) return "a block device node";
  return "an entry of an unrecognised type";
}

/** `readFileSync`, refusing anything that is not a regular file — and refusing it from the
 *  open descriptor, so there is no window in which the path can change under the check.
 *  Throws `NotARegularFileError`; every other failure (ENOENT, EACCES, ENXIO, EISDIR on
 *  platforms that refuse the open outright) propagates exactly as `readFileSync`'s does. */
export function readRegularFileSync(path, encoding = "utf8") {
  const fd = openSync(path, constants.O_RDONLY | NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NotARegularFileError(path, kindOf(info), "read");
    return readFileSync(fd, encoding);
  } finally {
    closeSync(fd);
  }
}

/** The same rule for a write, because `writeFileSync` blocks on a FIFO exactly as the read
 *  does — measured — and a `try/catch` around a blocking call catches nothing. `O_WRONLY |
 *  O_NONBLOCK` on a FIFO with no reader fails ENXIO immediately instead of blocking, so the
 *  caller's existing best-effort catch sees an error rather than never returning.
 *
 *  This writes NO TICKET and is not a second write seam (ADR-0006): it is the primitive its
 *  one caller — the transitions cache, already inside the write-seam allowlist — uses to
 *  stop its own best-effort write from hanging the process. */
export function writeRegularFileSync(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NONBLOCK, 0o666);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NotARegularFileError(path, kindOf(info), "write");
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The APPEND counterpart, and it exists for the same reason the other two do rather than as
 *  a convenience. `appendFileSync` opens the path exactly as `writeFileSync` does, so a FIFO
 *  with no reader blocks in `open(2)` — measured through the real `reconcile()`: `EXIT=124` at
 *  a 10s and again at a 25s `timeout`. A `try/catch` around a blocking call catches nothing,
 *  and `node:test`'s own timeout cannot rescue it either, because that timer lives on an event
 *  loop a synchronous open never yields to. `O_NONBLOCK` turns that into an immediate `ENXIO`,
 *  which a best-effort caller's catch can actually see.
 *
 *  `O_TRUNC` is the ONLY difference from `writeRegularFileSync`, and it is why this is a
 *  second function rather than a flag: a caller that appends must not be one flag's typo away
 *  from emptying the file it is appending to. `O_APPEND` also makes each write atomic against
 *  concurrent appenders up to `PIPE_BUF`, which is what lets several processes share one
 *  destination — the census instrument's whole shape, since `node --test` runs test files in
 *  parallel and reconcile spawns children of its own.
 *
 *  This writes NO TICKET and is not a second write seam (ADR-0006), on the same footing as
 *  its `O_TRUNC` sibling: it is a primitive for a best-effort, operator-enabled, non-board
 *  file — today the `BLZ_MEASURE` census log in `scripts/reconcile.mjs`.
 *
 *  REACHABILITY OF THE `isFile()` REFUSAL FROM TODAY'S ONE CALLER, stated rather than left to
 *  look pinned. It is `O_NONBLOCK` that saves the FIFO case, not this check: the open fails
 *  ENXIO before `fstatSync` is reached, and a directory fails EISDIR at the open for the same
 *  reason. Deleting the line reddens nothing in the suite, because the only shape it changes
 *  is a DEVICE NODE — `/dev/null` would silently swallow every record instead of being
 *  refused — and `census()` swallows the refusal either way, so no run decides differently.
 *  It is kept because its two siblings have it, because a caller that is not best-effort
 *  would need it, and because "the census went to /dev/null" is a thing an operator should be
 *  able to be told rather than a silence. Verified by mutation: dropping it from THIS
 *  function alone leaves `node --test tests/reconcile*.test.mjs` green. */
export function appendRegularFileSync(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | NONBLOCK, 0o666);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new NotARegularFileError(path, kindOf(info), "append to");
    appendFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}
