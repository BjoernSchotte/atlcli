"""PTY acceptance probe for a synthetic mounted Markdown directory."""
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

binary, directory, marker = sys.argv[1:4]
expected_count = int(sys.argv[4]) if len(sys.argv) > 4 else None
started = time.monotonic()
pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv(binary, [binary, "-t", "-s", "dark", directory])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
output = b""
listed = None
rendered = None
selected = None
scanned = None
counts = set()
next_resize = started + 0.5
width = 120
try:
    deadline = started + (60 if expected_count else 15)
    while time.monotonic() < deadline:
        # TUI renderers can update only changed digits. A native resize requests
        # a full frame, so a byte-stream probe need not emulate a terminal.
        if expected_count and selected is None and time.monotonic() >= next_resize:
            width = 119 if width == 120 else 120
            fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 30, width, 0, 0))
            os.kill(pid, signal.SIGWINCH)
            next_resize = time.monotonic() + 0.5
        if not select.select([terminal], [], [], 0.1)[0]:
            continue
        try:
            chunk = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        if b"\x1b[6n" in chunk:
            os.write(terminal, b"\x1b[1;1R")
        if b"\x1b]11;?" in chunk:
            os.write(terminal, b"\x1b]11;rgb:0000/0000/0000\x1b\\")
        output = (output + chunk)[-65536:]
        plain = re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]", b"", output)
        counts.update(int(n.replace(b",", b"")) for n in re.findall(rb"(\d[\d,]*) documents", plain))
        if listed is None and b"_index.md" in plain:
            listed = time.monotonic()
        if listed is not None and selected is None:
            complete = expected_count is None or re.search(
                rb"\b" + str(expected_count).encode() + rb" documents\b", plain)
            if complete:
                scanned = time.monotonic()
                output = b""
                selected = time.monotonic()
                os.write(terminal, b"\r")
        elif selected is not None and marker.encode() in plain:
            rendered = time.monotonic()
            break
    assert listed is not None, "Glow did not list _index.md before deadline"
    assert selected is not None, f"Glow expected {expected_count} documents; largest observed counts: {sorted(counts)[-5:]}"
    assert rendered is not None, "Glow did not render the selected fixture before deadline"
    result = {"listingMs": (listed - started) * 1000,
              "renderMs": (rendered - selected) * 1000}
    if expected_count is not None:
        result.update(scanMs=(scanned - started) * 1000, documents=expected_count)
    print(json.dumps(result))
finally:
    # Only the child created above is signalled; always reap it before returning.
    os.kill(pid, signal.SIGTERM)
    stop = time.monotonic() + 2
    while os.waitpid(pid, os.WNOHANG) == (0, 0):
        if time.monotonic() >= stop:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
            break
        time.sleep(0.05)
    os.close(terminal)
