#!/usr/bin/env python3
"""Interactive smoke test of the Windows atlcli.exe's TUI in a ConPTY console
(pywinpty): it draws its shell, `?` opens the help, Esc closes it, a mouse
click switches to the Wiki, `q` quits with exit 0. Needs no network: the
profile points at an unreachable site.

    pip install pywinpty==2.0.15
    python scripts/ci/tui-smoke-windows.py path\\to\\atlcli.exe
"""
import json
import os
import sys
import tempfile
import threading
import time

from winpty import PtyProcess


def main(binary: str) -> int:
    with tempfile.TemporaryDirectory() as tmp:
        config = os.path.join(tmp, "config.json")
        with open(config, "w") as f:
            json.dump({
                "currentProfile": "smoke",
                "profiles": {"smoke": {"name": "smoke", "baseUrl": "https://example.invalid", "deploymentType": "cloud", "auth": {"type": "bearer"}}},
            }, f)
        env = dict(os.environ, ATLCLI_CONFIG=config, ATLCLI_API_TOKEN="x", ATLCLI_DISABLE_UPDATE_CHECK="1")
        proc = PtyProcess.spawn([binary, "tui"], env=env, dimensions=(30, 120))
        out = {"text": ""}

        def pump():
            while True:
                try:
                    out["text"] += proc.read(65536)
                except EOFError:
                    return

        threading.Thread(target=pump, daemon=True).start()

        def wait_for(needle: str, since: int, what: str) -> int:
            deadline = time.time() + 20
            while time.time() < deadline:
                at = out["text"].find(needle, since)
                if at >= 0:
                    print(f"tui-smoke-windows: {what}")
                    return at + len(needle)
                if not proc.isalive():
                    break
                time.sleep(0.1)
            print(f"tui-smoke-windows: {what}: not seen; output tail:\n{out['text'][-1500:]}")
            proc.terminate(force=True)
            sys.exit(1)

        pos = wait_for("1 Jira", 0, "drew the shell")
        time.sleep(0.5)
        proc.write("?")
        pos = wait_for("esc closes", pos, "? opened the help")
        proc.write("\x1b")
        time.sleep(1)
        # Mouse: an SGR click on the header's " 2 Wiki " tab (row 1, columns 17-24) switches the area.
        proc.write("\x1b[<0;20;1M\x1b[<0;20;1m")
        pos = wait_for("Recently updated", pos, "a click on the Wiki tab switched the area")
        time.sleep(0.5)
        proc.write("q")
        deadline = time.time() + 20
        while proc.isalive() and time.time() < deadline:
            time.sleep(0.1)
        if proc.isalive():
            print(f"tui-smoke-windows: did not quit on q; output tail:\n{out['text'][-1500:]}")
            proc.terminate(force=True)
            return 1
        code = proc.exitstatus
        print(f"tui-smoke-windows: quit on q with {code}")
        return 0 if code == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
