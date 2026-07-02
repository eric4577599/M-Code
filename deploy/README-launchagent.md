# M-Code 部署 — 使用者層 LaunchAgent 路線(免 sudo,實際採用)

這是 `setup-macmini.sh`(系統 LaunchDaemon)之外的**實際採用路線**。原因:目標機環境無法互動輸入 sudo 密碼,且 repo 在外接 SSD 時 launchd 起的 process 沒有 FDA、讀不到 `/Volumes/...`。因此改為:

1. **內接碟 docroot** — 把 `demo/` + `dist/` 等 rsync 到 `~/m-code-site`(避開外接碟 FDA)。
2. **web** — 使用者層 LaunchAgent 跑 `m-code-serve.py`(送 `no-store` 標頭、雙協議綁 `::`),免 sudo。
3. **tunnel** — 使用者層 LaunchAgent 跑 `cloudflared tunnel run --token <token>`,免 sudo。

`no-store` 的用意:Cloudflare 預設會快取 `.js` 達 4 小時,改碼後不會即時生效;送 `no-store` 讓邊緣與瀏覽器都不快取(實測 `cf-cache-status: BYPASS`),改碼即時生效。

## 檔案
| 檔案 | 說明 |
|---|---|
| `m-code-serve.py` | no-store 靜態伺服器(DIRECTORY 指向內接碟 docroot;換機請改) |
| `launchagents/com.ericchh.mcode-web.plist` | web LaunchAgent(無機密) |
| `launchagents/com.ericchh.mcode-tunnel.plist.template` | tunnel LaunchAgent 模板(`@TUNNEL_TOKEN@` 佔位,安裝時替換) |

## 安裝
```bash
# 0. build + 同步 docroot
npm ci && npm run build
rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/

# 1. serve 腳本 + web agent
cp deploy/m-code-serve.py ~/m-code-serve.py
cp deploy/launchagents/com.ericchh.mcode-web.plist ~/Library/LaunchAgents/
mkdir -p ~/Library/Logs/m-code
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ericchh.mcode-web.plist

# 2. tunnel agent(token 由此帶入,絕不寫進 repo)
TOKEN='<你的 m-code tunnel token,eyJ...>'
sed "s#@TUNNEL_TOKEN@#${TOKEN}#" \
  deploy/launchagents/com.ericchh.mcode-tunnel.plist.template \
  > ~/Library/LaunchAgents/com.ericchh.mcode-tunnel.plist
chmod 600 ~/Library/LaunchAgents/com.ericchh.mcode-tunnel.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ericchh.mcode-tunnel.plist

# 3. 驗證
curl -sI http://localhost:8765/demo/index.html | head -1
curl -sI https://m-code.ericchh.work/demo/index.html | head -1
```

## 改碼生效
```bash
npm run build && rsync -a --delete --exclude node_modules --exclude .git ./ ~/m-code-site/
# no-store,完成即生效,無需 purge。
```

## 維運
```bash
# 重啟(換 web / 換 tunnel token 後)
launchctl bootout  gui/$(id -u) ~/Library/LaunchAgents/com.ericchh.mcode-<web|tunnel>.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ericchh.mcode-<web|tunnel>.plist
launchctl list | grep mcode
tail -f ~/Library/Logs/m-code/cloudflared.log
```

## 換 tunnel token(輪替)
編輯 `~/Library/LaunchAgents/com.ericchh.mcode-tunnel.plist` 的 `--token` 值(或用上面 sed 重生),再 bootout/bootstrap。舊 token 輪替後即作廢。

## 與系統 LaunchDaemon 版(setup-macmini.sh)的取捨
- 本路線:登入後常駐、免 sudo;**開機未登入前不跑**。Mac mini 設自動登入即等效。
- 要「開機未登入也跑」→ 用 `setup-macmini.sh`(需 sudo),並先卸載本 user agent 避免搶 8765 / 搶 tunnel;該版同樣需處理外接碟 FDA(建議 docroot 也走內接碟)。
