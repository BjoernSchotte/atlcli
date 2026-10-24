#!/usr/bin/env python3
"""Interactive smoke test of the Windows atlcli.exe's TUI in a ConPTY console
(pywinpty), against a local Jira stub (no network):

1. it draws its shell; `?` opens the help, Esc closes it;
2. `e` on the issue asks for the summary, opens `$EDITOR` (a script that
   appends a line), shows the diff, and `y` saves: the stub must receive the
   PUT with the edited description;
3. a mouse click on the header's Wiki tab switches the area;
4. `q` quits with exit 0.

    pip install --require-hashes --only-binary :all: -r scripts/ci/tui-smoke-windows-requirements.txt
    python scripts/ci/tui-smoke-windows.py path\\to\\atlcli.exe

`--notepad` (needs pywinauto and a desktop session, as GitHub's Windows
runners have) leaves $VISUAL/$EDITOR unset, so atlcli falls back to Notepad,
and drives Notepad itself: append a line, save, close.

`python scripts/ci/tui-smoke-windows.py --stub` only serves the stub (to
develop the scenario against a local build on any OS).
"""
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ISSUE = {
    "id": "1",
    "key": "AB-1",
    "fields": {
        "summary": "Smoke issue",
        "status": {"name": "To Do", "statusCategory": {"key": "new"}},
        "issuetype": {"name": "Task"},
        "project": {"key": "AB"},
        "description": {"type": "doc", "version": 1, "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Before."}]}]},
        "labels": [],
        "comment": {"comments": [], "total": 0},
    },
}
PUTS = []


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, code, body=None):
        data = b"" if body is None else json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/rest/api/3/myself":
            return self.reply(200, {"accountId": "me", "displayName": "Smoke"})
        if path == "/rest/api/3/issue/AB-1":
            return self.reply(200, ISSUE)
        # Everything else the shell asks for (navigator, comments, links…) is empty.
        return self.reply(200, {"values": [], "issues": [], "comments": [], "total": 0, "isLast": True})

    def do_POST(self):
        self.body()
        if self.path.split("?")[0] == "/rest/api/3/search/jql":
            return self.reply(200, {"issues": [ISSUE], "isLast": True})
        return self.reply(200, {"values": [], "issues": [], "total": 0})

    def do_PUT(self):
        if self.path.split("?")[0] == "/rest/api/3/issue/AB-1":
            PUTS.append(self.body())
            return self.reply(204)
        return self.reply(404, {"errorMessages": ["stub: no route"]})


def serve() -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def edit_in_notepad(marker: str) -> None:
    """Finds the Notepad that atlcli opened on AB-1.md, appends `marker`, saves and closes it."""
    import subprocess
    from pywinauto import Application, Desktop

    try:
        app = Application(backend="win32").connect(path="notepad.exe", timeout=30)
    except Exception:
        print(subprocess.run(["tasklist", "/v", "/fi", "imagename eq notepad.exe"], capture_output=True, text=True).stdout)
        print("windows:", [w.window_text() for w in Desktop(backend="win32").windows() if w.window_text()][:30])
        raise
    win = app.top_window()
    win.wait("ready", timeout=30)
    edit = win.child_window(class_name="Edit")
    edit.set_edit_text(edit.window_text() + f"\r\n\r\n{marker}\r\n")
    win.type_keys("^s")
    time.sleep(1)
    win.close()
    print("tui-smoke-windows: typed into Notepad, saved and closed it")


def main(binary: str, notepad: bool = False) -> int:
    from winpty import PtyProcess

    server = serve()
    with tempfile.TemporaryDirectory() as tmp:
        config = os.path.join(tmp, "config.json")
        with open(config, "w") as f:
            json.dump({
                "currentProfile": "smoke",
                "profiles": {"smoke": {"name": "smoke", "baseUrl": f"http://127.0.0.1:{server.server_port}", "deploymentType": "cloud", "auth": {"type": "apiToken", "email": "smoke@example.invalid"}}},
            }, f)
        editor = os.path.join(tmp, "editor.py")
        with open(editor, "w") as f:
            f.write("import sys\nopen(sys.argv[1], 'a', encoding='utf-8').write('\\n\\nEdited on Windows.\\n')\n")
        marker = "Edited in Notepad." if notepad else "Edited on Windows."
        env = dict(os.environ, ATLCLI_CONFIG=config, ATLCLI_API_TOKEN="x", ATLCLI_DISABLE_UPDATE_CHECK="1", EDITOR="" if notepad else f'"{sys.executable}" "{editor}"', VISUAL="")
        proc = PtyProcess.spawn([binary, "tui", "--jql", "key = AB-1"], env=env, dimensions=(30, 120))
        out = {"text": ""}

        def pump():
            while True:
                try:
                    out["text"] += proc.read(65536)
                except EOFError:
                    return

        threading.Thread(target=pump, daemon=True).start()

        def fail(what: str) -> None:
            print(f"tui-smoke-windows: {what}; output tail:\n{out['text'][-1500:]}")
            proc.terminate(force=True)
            sys.exit(1)

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
            fail(f"{what}: not seen")
            return 0

        pos = wait_for("1 Jira", 0, "drew the shell")
        pos = wait_for("Smoke issue", pos, "listed the stub issue")
        time.sleep(0.5)
        proc.write("?")
        pos = wait_for("esc closes", pos, "? opened the help")
        proc.write("\x1b")
        time.sleep(1)

        proc.write("e")
        pos = wait_for("Summary of AB-1", pos, "e asked for the summary")
        proc.write("\r")
        if notepad:
            edit_in_notepad(marker)
        pos = wait_for("Save AB-1?", pos, "the editor ran and the diff came up")
        proc.write("y")
        pos = wait_for("AB-1 saved", pos, "y saved the edit")
        sent = json.dumps(PUTS[-1] if PUTS else {})
        if marker not in sent:
            fail(f"the PUT lacks the edited description: {sent[:300]}")
        print("tui-smoke-windows: the stub received the edited description")

        # Mouse: an SGR click on the header's " 2 Wiki " tab (row 1, columns 17-24) switches the area.
        proc.write("\x1b[<0;20;1M\x1b[<0;20;1m")
        pos = wait_for("Recently updated", pos, "a click on the Wiki tab switched the area")
        time.sleep(0.5)
        proc.write("q")
        deadline = time.time() + 20
        while proc.isalive() and time.time() < deadline:
            time.sleep(0.1)
        if proc.isalive():
            fail("did not quit on q")
        code = proc.exitstatus
        print(f"tui-smoke-windows: quit on q with {code}")
        return 0 if code == 0 else 1


if __name__ == "__main__":
    if sys.argv[1] == "--stub":
        s = serve()
        print(f"http://127.0.0.1:{s.server_port}", flush=True)
        while True:
            time.sleep(60)
    sys.exit(main(sys.argv[-1], notepad="--notepad" in sys.argv))
