# 2026 世界盃虛擬下注

GitHub Pages + GitHub Actions 靜態網站。

## 架構

- `index.html`：純前端頁面，只讀取 `data/worldcup2026.json`。
- `scripts/fetch-worldcup.js`：由 GitHub Actions 執行，抓取世界盃資料並整理成前端格式。
- `.github/workflows/update-worldcup-data.yml`：每 5 分鐘更新一次資料，也可手動執行。
- `data/worldcup2026.json`：前端讀取的靜態資料檔。

## 行為

- 賽事資料讀不到時，前端會停用下注。
- 下注紀錄與餘額只存在使用者瀏覽器 `localStorage`。
- 當資料檔有比分結果後，前端會自動結算待結算下注並調整餘額。

## 啟用 GitHub Pages

到 repo：`Settings` → `Pages`。

設定：

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/root`

網址會是：

```text
https://Kan090808.github.io/worldcup2026-bet/
```

## 手動更新資料

到 `Actions` → `Update World Cup data` → `Run workflow`。

## 更換資料來源

可以在 Actions variables 或 secrets 設定：

```text
WC_SOURCE_URL=https://your-source/worldcup2026.json
```

或直接修改 `scripts/fetch-worldcup.js` 的 `SOURCE_URL`。
