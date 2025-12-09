// index.js

// 1. 引用 Express 函式庫
const express = require('express');
const app = express();

// 關鍵設定：使用環境變數 (process.env.PORT)
// PaaS 平台（如 Zeabur）會自動指定一個 Port 給你，我們不能寫死 Port 號。
const port = process.env.PORT || 3000; 

// 建立一個簡單的路由：當訪問根目錄 (/) 時，回傳訊息
app.get('/', (req, res) => {
  res.send('Hello, Cal Backend is Running on Zeabur!');
});

// 2. 啟動伺服器並監聽 Port
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
