#!/usr/bin/python3
"""Test double for luady-hub in the deploy test container.

It serves GET /internal/health on /home/luady/run/hub.sock and requires the bearer token from
hub-token, like the real hub's internal API. It exits at once when the current release's
packages/hub/dist/main.js contains BROKEN, which simulates a crashing release.
"""
import http.server
import os
import socketserver
import sys

ROOT = '/home/luady'
SOCK = f'{ROOT}/run/hub.sock'

with open(f'{ROOT}/app/current/packages/hub/dist/main.js', encoding='utf-8') as fh:
    if 'BROKEN' in fh.read():
        sys.exit('fake hub: this release is broken')
with open(f'{ROOT}/.config/luady/hub-token', encoding='utf-8') as fh:
    TOKEN = fh.read().strip()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        ok = self.path == '/internal/health' and self.headers.get('Authorization') == f'Bearer {TOKEN}'
        body = b'{"ok":true}' if ok else b'{"error":{"code":"auth","message":"unauthorized"}}'
        self.send_response(200 if ok else 401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args) -> None:
        pass


class UnixHTTPServer(socketserver.UnixStreamServer):
    def get_request(self):
        request, _ = super().get_request()
        return request, ('hub.sock', 0)


if os.path.exists(SOCK):
    os.unlink(SOCK)
with UnixHTTPServer(SOCK, Handler) as server:
    os.chmod(SOCK, 0o600)
    server.serve_forever()
