#!/usr/bin/env python3
"""
Serve the QSBuddy app at http://localhost:8765 and open it in your browser.

    python tools/serve.py [port]

Only needed if your browser won't give MIDI access to a page opened straight
from disk (file://). localhost counts as a secure origin, so Web MIDI works.
Standard library only.
"""
import functools
import http.server
import os
import sys
import threading
import webbrowser

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
ROOT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'app')


def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler) as httpd:
        url = 'http://localhost:%d/' % PORT
        print('QSBuddy at %s  (Ctrl+C to stop)' % url)
        threading.Timer(0.5, webbrowser.open, (url,)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
