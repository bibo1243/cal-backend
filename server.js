// 引入必要的模組
const express = require('express');
const mysql = require('mysql2/promise'); // 使用 Promise 版本方便異步操作
// 移除 XLSX 和 fs 引用，因為它們在核心 API 邏輯中未使用
// const XLSX = require('xlsx');
// const fs = require('fs');
const path = require('path');
const app = express();

// PaaS 平台會自動設定 PORT，我們使用環境變數
const PORT = process.env.PORT || 8080; // Zeabur 預設 Port 號通常是 8080
const PUBLIC_DIR = path.join(__dirname); // 靜態檔案目錄 (目前是根目錄)

// --- 資料庫連線設定 ---
// 優先檢查手動設定的 DB_* 變數，其次檢查 Zeabur 自動注入的 MYSQL_* 變數
let pool;

async function connectToDatabase() {
    let dbConfig = {};
    
    // 優先檢查我們手動設定的 DB_ 變數
    if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME) {
        dbConfig = {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            port: process.env.MYSQL_PORT || 3306 // PORT 仍然可能需要從 MYSQL_PORT 或預設值獲取
        };
        console.log("ℹ️ 偵測到手動設定的 DB_* 變數。");
        
    } 
    // 其次檢查 Zeabur 自動注入的 MYSQL_ 變數 (如果它們被正確展開)
    else if (process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_PASSWORD && process.env.MYSQL_DATABASE) {
        dbConfig = {
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
            port: process.env.MYSQL_PORT || 3306
        };
        console.log("ℹ️ 偵測到 Zeabur 自動注入的 MYSQL_* 變數。");
        
    } else {
        // 連線失敗警告
        console.error("❌ 警告：未找到任何完整的 MySQL 連線變數。");
        console.error("❌ 服務將以離線模式啟動，無法永久儲存資料。");
        return;
    }

    try {
        // 關鍵修正：確保 MySQL 驅動程式正確處理 JSON 類型欄位
        dbConfig.typeCast = function (field, next) {
            if (field.type === 'JSON') {
                return field.string(); // 將 JSON 欄位強制轉換為字串，方便後續的 JSON.parse
            }
            return next();
        };

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
        // 發生錯誤時，將 pool 設為 null，以防止 API 嘗試使用錯誤的連線
        pool = null; 
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
    res.send({ status: 'ok', message: 'Cal Planner Backend is running.', dbConnected: !!pool });
});

// --- 輔助函式：安全解析 JSON ---
// 處理資料庫讀取時，row.data 可能是字串或物件的情況
function safeParseJson(data) {
    if (typeof data === 'string') {
        try {
            return JSON.parse(data);
        } catch (e) {
            console.error('JSON.parse 錯誤:', e.message);
            return null;
        }
    }
    // 如果它已經是物件，直接回傳
    return data; 
}


// --- API 接口：資料 CRUD ---

// GET: 載入指定年份的所有資料
app.get('/api/plan/:year', async (req, res) => {
    // 檢查連線狀態
    if (!pool) return res.status(503).json({ error: '資料庫離線，無法載入資料' });
    
    const year = parseInt(req.params.year);
    
    try {
        const [rows] = await pool.query('SELECT data, theme, bg_images FROM annual_plans WHERE year = ?', [year]);
        if (rows.length > 0) {
            const row = rows[0];
            
            // 使用安全解析函式
            const parsedData = safeParseJson(row.data);
            const parsedBgImages = safeParseJson(row.bg_images);

            if (!parsedData || !parsedBgImages) {
                return res.status(500).json({ error: '資料庫返回的 JSON 數據格式錯誤，無法解析。' });
            }

            const responseData = {
                year: year,
                theme: row.theme,
                yearData: parsedData.yearData,
                monthData: parsedData.monthData,
                backgroundImages: parsedBgImages
            };
            return res.json(responseData);
        } else {
            // 如果找不到資料，回傳 404，前端會用預設值初始化
            return res.status(404).json({ message: `找不到 ${year} 年的資料` });
        }
    } catch (error) {
        console.error('資料載入失敗:', error.message);
        return res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// POST: 保存/更新所有年度資料 (這是主要保存接口)
app.post('/api/plan/:year', async (req, res) => {
    // 檢查連線狀態
    if (!pool) return res.status(503).json({ error: '資料庫離線，無法保存資料' });
    
    const year = parseInt(req.params.year);
    const { yearData, monthData, theme, backgroundImages } = req.body;
    
    if (!yearData || !monthData) {
        return res.status(400).json({ error: '缺少必要的年度或月度數據' });
    }
    
    // 構造要存儲的數據結構
    const fullData = { yearData, monthData };
    
    try {
        // 使用 JSON.stringify 確保數據以正確的 JSON 格式存入 MySQL
        const result = await pool.query(
            `INSERT INTO annual_plans (year, data, theme, bg_images) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE data = VALUES(data), theme = VALUES(theme), bg_images = VALUES(bg_images)`,
            [year, JSON.stringify(fullData), theme, JSON.stringify(backgroundImages)]
        );

        return res.json({ success: true, message: `${year} 年規劃已保存` });
    } catch (error) {
        console.error('資料保存失敗:', error.message);
        return res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// --- API 接口：Excel 匯入/匯出 (檔案處理) ---
// 這裡的 /api/data 接口用於前端的 loadData (替代 Excel 載入數據)

app.get('/api/data', async (req, res) => {
    // 這裡直接使用 /api/plan/:year 的邏輯，回傳最新年份的 JSON 數據。
    if (!pool) return res.status(503).send('資料庫離線，無法載入資料');
    
    try {
        const [rows] = await pool.query('SELECT year, data, theme, bg_images FROM annual_plans ORDER BY year DESC LIMIT 1');
        if (rows.length > 0) {
            const row = rows[0];
            
            const parsedData = safeParseJson(row.data);
            const parsedBgImages = safeParseJson(row.bg_images);
            
            if (!parsedData || !parsedBgImages) {
                return res.status(500).json({ error: '資料庫返回的 JSON 數據格式錯誤，無法解析。' });
            }

            const responseData = {
                year: row.year,
                theme: row.theme,
                yearData: parsedData.yearData,
                monthData: parsedData.monthData,
                backgroundImages: parsedBgImages
            };
            return res.json(responseData);
        } else {
            return res.status(404).send('沒有任何已保存的年度資料');
        }
    } catch (error) {
        console.error('自動載入資料失敗:', error.message);
        return res.status(500).send('伺服器內部錯誤');
    }
});


// 監聽 Port
app.listen(PORT, () => {
    console.log(`🚀 伺服器啟動於 Port ${PORT}`);
    console.log(`📢 服務網址: http://localhost:${PORT}`);
});
