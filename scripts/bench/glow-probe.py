"""PTY acceptance probe for a synthetic mounted Markdown directory."""
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time

binary, directory, marker = sys.argv[1:]
started = time.monotonic()
pid, terminal = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execv(binary, [binary, "-t", "-s", "dark", directory])
fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
output = b""
listed = None
rendered = None
try:
    deadline = started + 15
    while time.monotonic() < deadline:
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
        if listed is None and b"_index.md" in output:
            listed = time.monotonic()
            output = b""
            os.write(terminal, b"\r")
        elif listed is not None and marker.encode() in output:
            rendered = time.monotonic()
            break
    assert listed is not None, "Glow did not list _index.md within 15 seconds"
    assert rendered is not None, "Glow did not render the selected fixture within 15 seconds"
    print(json.dumps({"listingMs": (listed - started) * 1000,
                      "renderMs": (rendered - listed) * 1000}))
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
