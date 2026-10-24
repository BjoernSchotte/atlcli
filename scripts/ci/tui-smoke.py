#!/usr/bin/env python3
"""Smoke test of a built atlcli binary's TUI: it starts in a pseudo-terminal,
draws its shell (so OpenTUI's native library loaded), and quits with exit 0,
once on `q` and once on SIGTERM. Needs no network: the profile points at an
unreachable site.

    python3 scripts/ci/tui-smoke.py path/to/atlcli
"""
import json
import os
import pty
import select
import signal
import sys
import tempfile
import time


def main(binary: str) -> int:
    return run(binary, b"q") or run(binary, None)


def run(binary: str, quit_key) -> int:
    """Starts the TUI, waits for the shell, then quits with `quit_key`, or with SIGTERM when it is None."""
    with tempfile.TemporaryDirectory() as tmp:
        config = os.path.join(tmp, "config.json")
        with open(config, "w") as f:
            json.dump({
                "currentProfile": "smoke",
                "profiles": {"smoke": {"name": "smoke", "baseUrl": "https://example.invalid", "deploymentType": "cloud", "auth": {"type": "bearer"}}},
            }, f)
        env = dict(os.environ, ATLCLI_CONFIG=config, ATLCLI_API_TOKEN="x", ATLCLI_DISABLE_UPDATE_CHECK="1", TERM="xterm-256color", COLUMNS="120", LINES="30")
        pid, fd = pty.fork()
        if pid == 0:
            os.execve(binary, [binary, "tui"], env)
        seen = b""
        deadline = time.time() + 20
        quit_sent = False
        how = "SIGTERM" if quit_key is None else f"key {quit_key.decode()}"
        while time.time() < deadline:
            ready, _, _ = select.select([fd], [], [], 0.2)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    chunk = b""
                if not chunk:
                    # The terminal closed: the process is exiting.
                    _, status = os.waitpid(pid, 0)
                    code = os.waitstatus_to_exitcode(status)
                    if not quit_sent:
                        print(f"tui-smoke: exited ({code}) before drawing; output tail:\n{seen[-800:].decode(errors='replace')}")
                        return 1
                    print(f"tui-smoke: drew the shell and quit ({how}) with {code}")
                    return 0 if code == 0 else 1
                seen += chunk
            if not quit_sent and b"1 Jira" in seen:
                time.sleep(0.5)
                if quit_key is None:
                    os.kill(pid, signal.SIGTERM)
                else:
                    os.write(fd, quit_key)
                quit_sent = True
            done, status = os.waitpid(pid, os.WNOHANG)
            if done:
                code = os.waitstatus_to_exitcode(status)
                if not quit_sent:
                    print(f"tui-smoke: exited ({code}) before drawing; output tail:\n{seen[-800:].decode(errors='replace')}")
                    return 1
                print(f"tui-smoke: drew the shell and quit ({how}) with {code}")
                return 0 if code == 0 else 1
        os.kill(pid, 9)
        print(f"tui-smoke: {'did not quit' if quit_sent else 'never drew the shell'} within 20s; output tail:\n{seen[-800:].decode(errors='replace')}")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
