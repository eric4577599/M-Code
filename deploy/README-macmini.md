# M-Code 互動測試台 — Mac mini 部署

把 M-Code 的 demo 測試台（`m-code.ericchh.work`）從筆電（Windows 登入腳本／Docker 連接器）搬到 Mac mini，改用 **開機常駐 + 斷線自動重連** 的 launchd 服務，根治「筆電睡眠／熱點斷線後變 1033／502」的問題。

兩個元件都註冊成 launchd 服務（開機自動起、掛掉自動重啟）：

| 服務 | 內容 | 對外 |
|------|------|------|
| `com.ericchh.mcode-web` | `python3 -m http.server 8765`（靜態檔，serve 本 repo 目錄） | `http://[::]:8765` |
| cloudflared tunnel | 把 8765 曝光到網路 | `https://m-code.ericchh.work` |

入口頁是 **`/demo/index.html`**（桌面三分頁測試台）與 **`/demo/mobile.html`**（手機簡易版）。demo 以 ESM 直接 `import "../dist/index.js"`，所以**部署時要先 `npm run build` 產生 `dist/`**。

Cloudflare 後台的 ingress 已是 `m-code.ericchh.work → http://localhost:8765`，**換機器不用改後台**，同一個 tunnel token 在 Mac 上跑即可。

---

## 前置

- macOS，建議**接有線網路**、**關閉自動睡眠**（系統設定 → 能源）。
- `python3`（macOS 內建即可，或 `brew install python`）。
- **Node.js**（建置 demo 用）：`brew install node`。
- Homebrew（裝 cloudflared 用）：https://brew.sh

## 安裝步驟

```bash
# 1. 取得程式碼
git clone https://github.com/eric4577599/M-Code.git
cd M-Code

# 2. 一鍵安裝（含 tunnel）—— 把 <TOKEN> 換成 m-code tunnel 的 token
chmod +x deploy/setup-macmini.sh
./deploy/setup-macmini.sh <TOKEN>
```

`setup-macmini.sh` 會：

1. `npm ci` + `npm run build`（TypeScript → `dist/`，demo 才能載入）。
2. 產生並載入靜態 web 的 launchd daemon（會要 `sudo` 密碼）。
3. 驗證 `http://localhost:8765/demo/index.html`。
4. 若有給 token：安裝 cloudflared 並 `cloudflared service install <TOKEN>`，再驗證 `https://m-code.ericchh.work/demo/index.html`。

> **不給 token 也可以**：`./deploy/setup-macmini.sh`（只裝 web），之後再手動跑：
> ```bash
> brew install cloudflared
> sudo cloudflared service install <TOKEN>
> ```

### token 從哪來

- 舊的 Windows 啟動腳本 `Startup\m-detector-startup.vbs` 裡，**第二個** tunnel（m-code，tunnel ID `2cad6e8b-…`）那一行 `--token` 後面的長字串；**或**
- Cloudflare Zero Trust → Networks → Tunnels → `m-code` → Configure，複製安裝指令裡的 token。

token 是機密，**不要 commit 進 repo**，只在指令列傳入。

## 為什麼一定要 `--bind ::`（雙協議）

cloudflared 連 origin 時打的是 `localhost`，會**先解析到 IPv6 的 `::1`**。若 web server 只綁 IPv4，edge 會拿到 502。launchd plist 已固定用 `--bind ::`（雙協議），native／Docker 都適用。

## 驗收

```bash
curl -i http://localhost:8765/demo/index.html           # 本機 200
curl -i https://m-code.ericchh.work/demo/index.html      # 對外 200
```

兩個都 200、瀏覽器打得開測試台就完成了。

## 收尾：停掉舊的 Windows 連接器

確認 Mac mini 對外正常後，**停用舊筆電的 m-code 連接器**，避免兩個 connector 搶同一個 tunnel 造成 edge 負載平衡到壞掉的那個（間歇性 502）：

- 舊 Windows 啟動腳本 `Startup\m-detector-startup.vbs` 裡的第二個 tunnel；**或**
- 舊的 Docker 容器 `cloudflared-mcode` / `m-code-web`。

## 日常維運

```bash
# 重啟 web server
sudo launchctl bootout  system /Library/LaunchDaemons/com.ericchh.mcode-web.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/com.ericchh.mcode-web.plist

# 看 log
tail -f ~/Library/Logs/m-code/mcode-web.err.log

# cloudflared 服務狀態
sudo launchctl list | grep cloudflared

# 改完程式碼要生效
git pull && npm run build   # 然後重啟 web server（見上方）
```

## 疑難排解

| 症狀 | 原因 / 處理 |
|------|------------|
| 對外 **1033** | cloudflared 沒在跑 → `sudo launchctl list \| grep cloudflared`，或重跑 `sudo cloudflared service install <TOKEN>` |
| 對外 **502** | tunnel 活著但 8765 沒回應，常見是只綁 IPv4 → 確認 plist 用 `--bind ::`；或同一 tunnel 還有舊 connector 沒關 |
| demo 頁空白／import 失敗 | 沒先 `npm run build`，`dist/index.js` 不存在 → 重跑 build |
| 根網址 `/` 只看到檔案清單 | 正常；入口是 `/demo/index.html` 與 `/demo/mobile.html` |
