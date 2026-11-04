"""Drive the Safari test VM's screen over VNC: screenshot, click, type, keys.

Tart's --vnc-experimental server belongs to the host's virtualization
framework, not the guest, so this needs no Accessibility or Screen Recording
permission inside macOS and never touches the host's own screen or focus.

Usage (normally through scripts/safari-vm.sh):
  vnc.py URLFILE shot OUT.png
  vnc.py URLFILE click X Y [--double] [--right]
  vnc.py URLFILE scroll X Y up|down [TICKS]
  vnc.py URLFILE type TEXT
  vnc.py URLFILE key KEY [KEY ...]      e.g. enter, esc, tab, down

Tart's VNC server drops modifiers: Command and Shift never reach the guest,
so cmd-w is a plain w and typed capitals come out lowercase. Use the menu
bar instead of shortcuts, and `sh` (pbcopy, osascript) for anything typed
that needs capitals.

  vnc.py URLFILE serve SOCKET           hold one connection; take commands on SOCKET
  vnc.py --socket SOCKET VERB ARGS...   send one command to a running `serve`

Every VNC connect risks crashing the VM (see serve()), so safari-vm.sh runs
one `serve` per boot and sends each command through its socket.

URLFILE holds the vnc:// URL Tart printed (it carries the VNC password, so it
is read from a file and never passed on the command line).
"""

import json
import os
import socket
import sys
import time
import warnings
from urllib.parse import urlparse

warnings.filterwarnings("ignore", message=".*TripleDES")

from vncdotool import api  # noqa: E402
from vncdotool.keys import KEYMAP  # noqa: E402


def connect(url_file):
    with open(url_file) as f:
        url = urlparse(f.read().strip())
    return api.connect(f"{url.hostname}::{url.port}", password=url.password or None)


# vncdotool names Command "super" and Option "alt", and has no names for
# punctuation; accept the Mac names
MAC_KEYS = {"cmd": "super", "command": "super", "opt": "alt", "option": "alt",
            "comma": ",", "period": ".", "slash": "/", "semicolon": ";"}


def mac_key(key):
    if len(key) == 1:
        return key
    parts = [MAC_KEYS.get(part, part) for part in key.split("-")]
    for part in parts:
        # An unknown name fails inside vncdotool's thread and hangs the client
        if len(part) != 1 and part not in KEYMAP:
            raise SystemExit(f"unknown key: {part}")
    return "-".join(parts)


def run(client, verb, args):
    if verb == "shot":
        # No pointer nudge: moving it over the menu bar would switch an
        # open menu to the Apple menu
        client.captureScreen(args[0])
    elif verb == "click":
        x, y = int(args[0]), int(args[1])
        button = 3 if "--right" in args else 1
        client.mouseMove(x, y)
        time.sleep(0.1)
        client.mousePress(button)
        if "--double" in args:
            client.mousePress(button)
    elif verb == "scroll":
        x, y, ticks = int(args[0]), int(args[1]), int(args[3]) if len(args) > 3 else 3
        client.mouseMove(x, y)
        for _ in range(ticks):
            # Buttons 4 and 5 are the scroll wheel's up and down
            client.mousePress(4 if args[2] == "up" else 5)
            time.sleep(0.05)
    elif verb == "type":
        for ch in " ".join(args):
            client.keyPress("space" if ch == " " else ch)
    elif verb == "key":
        for key in [mac_key(k) for k in args]:
            client.keyPress(key)
            time.sleep(0.1)
    else:
        raise SystemExit(f"unknown verb: {verb}")


def serve(url_file, sock_path):
    """Hold one VNC connection and run each command sent to SOCK_PATH on it.

    Each new VNC client can crash the VM: Apple's VNC server hits an
    assertion (-[_VZVirtualMachineAccessor addAccessorObserver:]) on connect
    and takes tart down with it. One connection for the VM's whole life
    avoids that.
    """
    client = connect(url_file)
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    old = os.umask(0o077)
    server.bind(sock_path)
    os.umask(old)
    server.listen(1)
    try:
        while True:
            conn, _ = server.accept()
            with conn:
                argv = json.loads(conn.makefile().readline())
                try:
                    run(client, argv[0], argv[1:])
                    conn.sendall(b"ok\n")
                except SystemExit as e:
                    conn.sendall(f"error: {e}\n".encode())
                except Exception as e:
                    # The connection is gone (the VM stopped): let the next
                    # command start a fresh daemon
                    conn.sendall(f"error: {e!r}\n".encode())
                    return 1
    finally:
        server.close()
        os.unlink(sock_path)
        api.shutdown()


def send(sock_path, argv):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.connect(sock_path)
        s.sendall((json.dumps(argv) + "\n").encode())
        reply = s.makefile().readline().strip()
    if reply != "ok":
        print(reply or "error: no reply", file=sys.stderr)
        return 1
    return 0


def main(argv):
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    if argv[1] == "--socket":
        # The daemon runs in its own directory: send it an absolute path
        args = argv[3:]
        if args and args[0] == "shot":
            args = ["shot", os.path.abspath(args[1])]
        return send(argv[2], args)
    url_file, verb, args = argv[1], argv[2], argv[3:]
    if verb == "serve":
        return serve(url_file, args[0])
    client = connect(url_file)
    try:
        run(client, verb, args)
    finally:
        client.disconnect()
        api.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
