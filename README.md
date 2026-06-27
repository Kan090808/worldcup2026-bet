# 2026 世界盃虛擬下注：模型賠率版

這版不使用真實博彩公司賠率，也不需要 API key。

## 賠率基礎

1. Elo-like 球隊強度表：每支球隊一個透明的強度分數。
2. Poisson 分數分布：由兩隊預期進球數推算所有比分機率。
3. Bookmaker-style margin：在公平賠率上加入水位，讓虛擬賠率比較接近運彩顯示。

## 支援玩法

- 勝平負 h2h
- 讓球 spreads：目前使用半球盤，避免走盤。
- 正確比分 correct_score：取機率最高的 16 個比分。

## 檔案

- `index.html`：前端下注頁。
- `scripts/fetch-worldcup.js`：抓賽事資料並產生模型賠率。
- `data/worldcup2026.json`：前端讀取的靜態資料。
- `.github/workflows/update-worldcup-data.yml`：定時更新資料。

## 測試

```bash
node -c scripts/fetch-worldcup.js
node scripts/fetch-worldcup.js
```

輸出會寫入：

```text
data/worldcup2026.json
```

## 注意

這是虛擬模型賠率，不是真實博彩公司賠率。Elo-like rating table 是透明種子資料，之後可以改成從公開排名或自建資料源更新。
