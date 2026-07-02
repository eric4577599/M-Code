#!/usr/bin/env python3
# M-Code demo 靜態伺服器(取代 python -m http.server)。
# 差別:每個回應都送 Cache-Control: no-store —— 避免 Cloudflare 邊緣 / 瀏覽器
# 快取舊 .js,讓改碼後更新即時生效。仍雙協議綁 :: (cloudflared 連 localhost
# 會先解析 ::1,單 IPv4 會給 edge 502)。
#
# 部署:由使用者層 LaunchAgent com.ericchh.mcode-web 啟動(見同目錄
# launchagents/ 與 README-launchagent.md)。DIRECTORY 指向內接碟 docroot
# (避開外接碟 launchd FDA 限制)。
import socket
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

DIRECTORY = "/Users/hezhaoxing/m-code-site"
PORT = 8765


class NoStoreHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        # 關掉快取:邊緣與瀏覽器都即時重抓。
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        super().end_headers()


class DualStackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        # 讓 IPv6 socket 同時接受 IPv4(等同 http.server --bind ::)。
        try:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        except (AttributeError, OSError):
            pass
        super().server_bind()


if __name__ == "__main__":
    DualStackServer(("::", PORT), NoStoreHandler).serve_forever()
