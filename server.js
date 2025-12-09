// 引入必要的模組
const express = require('express');
const mysql = require('mysql2/promise'); // 使用 Promise 版本方便異步操作
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const app = express();

// PaaS 平台會自動設定 PORT，我們使用環境變數
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname); // 靜態檔案目錄 (目前是根目錄)

// --- 資料庫連線設定 (Zeabur 自動注入) ---
// Zeabur 會自動注入這些環境變數，請確保您已在 Zeabur 專案中部署 MySQL 服務
const dbConfig = {
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || 'planner_db',
    port: process.env.MYSQL_PORT
};

let pool;

async function connectToDatabase() {
    try {
        // 嘗試連線到資料庫
        pool = mysql.createPool(dbConfig);
        console.log('✅ MySQL 資料庫連線池建立成功！');
        
        // 檢查並創建表格
        await pool.query(`
            CREATE TABLE IF NOT EXISTS annual_plans (
                id INT AUTO_INCREMENT PRIMARY KEY,
                year INT NOT NULL,
                data JSON NOT NULL,
                theme VARCHAR(50),
                bg_images JSON,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY unique_year (year)
            );
        `);
        console.log('✅ 資料表 annual_plans 檢查/創建完成。');
        
    } catch (err) {
        console.error('❌ 資料庫連線或初始化失敗:', err.message);
        // 如果連線失敗，仍允許服務啟動，但 API 將無法運作
    }
}

connectToDatabase();

// --- 中介軟體 (Middleware) ---
// 讓 Express 能夠解析 JSON 請求和處理大檔案 (Excel)
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ limit: '10mb', type: 'application/octet-stream' }));

// 啟用靜態檔案服務：將整個目錄 (包含 index.html) 公開
// 這樣前端 (index.html) 就可以直接被訪問
app.use(express.static(PUBLIC_DIR));

// 伺服器健康檢查 (Zeabur 部署成功訊息)
app.get('/api/status', (req, res) => {
    res.send({ status: 'ok', message: 'Cal Planner Backend is running.' });
});

// --- API 接口：資料 CRUD ---

// GET: 載入指定年份的所有資料
app.get('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫連線尚未建立' });
    const year = parseInt(req.params.year);
    
    try {
        const [rows] = await pool.query('SELECT data, theme, bg_images FROM annual_plans WHERE year = ?', [year]);
        if (rows.length > 0) {
            const row = rows[0];
            const responseData = {
                year: year,
                theme: row.theme,
                yearData: row.data.yearData,
                monthData: row.data.monthData,
                backgroundImages: row.bg_images
            };
            return res.json(responseData);
        } else {
            // 如果找不到資料，回傳 404，前端會用預設值初始化
            return res.status(404).json({ message: `找不到 ${year} 年的資料` });
        }
    } catch (error) {
        console.error('資料載入失敗:', error);
        return res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// POST: 保存/更新所有年度資料 (這是主要保存接口)
app.post('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫連線尚未建立' });
    const year = parseInt(req.params.year);
    const { yearData, monthData, theme, backgroundImages } = req.body;
    
    if (!yearData || !monthData) {
        return res.status(400).json({ error: '缺少必要的年度或月度數據' });
    }
    
    // 構造要存儲的數據結構
    const fullData = { yearData, monthData };
    
    try {
        const result = await pool.query(
            `INSERT INTO annual_plans (year, data, theme, bg_images) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE data = VALUES(data), theme = VALUES(theme), bg_images = VALUES(bg_images)`,
            [year, JSON.stringify(fullData), theme, JSON.stringify(backgroundImages)]
        );

        return res.json({ success: true, message: `${year} 年規劃已保存` });
    } catch (error) {
        console.error('資料保存失敗:', error);
        return res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// --- API 接口：Excel 匯入/匯出 (檔案處理) ---
// Zeabur 不允許檔案系統寫入，但我們可以用 API 模擬檔案傳輸。

// POST /api/export (模擬 Excel 導出)
// 前端將數據傳給 API，API 模擬生成 Excel 文件並回傳給前端下載。
app.post('/api/export', (req, res) => {
    // 這裡我們假設前端將要導出的數據作為 JSON 傳過來 (但實際前端 XLSX 庫在處理)
    // 由於我們在前端已經使用 XLSX 庫生成了檔案，這個 API 保持精簡，只處理必要的資料。
    // 但是，如果你要將檔案儲存在伺服器上（例如 data.xlsx），你需要下面的 /api/data 接口。
    res.json({ success: true, message: '前端負責 XLSX 導出' });
});

// GET /api/data (模擬 Excel 檔案載入 - 實現自動保存)
// 從資料庫載入最新數據，並將其格式化成 Excel 讓前端讀取 (用於載入數據而非下載)
app.get('/api/data', async (req, res) => {
    if (!pool) return res.status(503).send('資料庫連線尚未建立');
    
    // 這裡我們直接使用 /api/plan/:year 的邏輯，回傳 JSON 數據，前端接收後會用 JSON 載入。
    // (因為實現一個後端 XLSX 生成器較複雜且 Zeabur 環境不允許直接存取檔案)
    
    // 這裡假設我們要取得當前年份的資料 (前端會在 loadFromServer 決定要哪個年份)
    // 為了簡化，我們只回傳最新的年份資料。
    try {
        const [rows] = await pool.query('SELECT year, data, theme, bg_images FROM annual_plans ORDER BY year DESC LIMIT 1');
        if (rows.length > 0) {
            const row = rows[0];
            const responseData = {
                year: row.year,
                theme: row.theme,
                yearData: row.data.yearData,
                monthData: row.data.monthData,
                backgroundImages: row.bg_images
            };
            return res.json(responseData);
        } else {
            return res.status(404).send('沒有任何已保存的年度資料');
        }
    } catch (error) {
        console.error('自動載入資料失敗:', error);
        return res.status(500).send('伺服器內部錯誤');
    }
});


// 監聽 Port
app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動於 Port ${PORT}`);
    console.log(`📢 服務網址: http://localhost:${PORT}`);
});
