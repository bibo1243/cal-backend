// 引入必要的模組
const express = require('express');
const mysql = require('mysql2/promise'); // 使用 Promise 版本方便異步操作
const path = require('path');
const app = express();

// PaaS 平台會自動設定 PORT，我們使用環境變數
const PORT = process.env.PORT || 8080; 
const PUBLIC_DIR = path.join(__dirname); 

// --- 資料庫連線設定 ---
let pool;

async function connectToDatabase() {
    let dbConfig = {};
    
    // 優先檢查手動設定的 DB_ 變數
    if (process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASS && process.env.DB_NAME) {
        dbConfig = {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            port: process.env.MYSQL_PORT || 3306,
            // 🌟 修正：確保連線使用 utf8mb4
            charset: 'UTF8MB4_GENERAL_CI', // mysql2 有時需要用這種格式來指定 charset
            timezone: '+08:00'
        };
        console.log("ℹ️ 偵測到手動設定的 DB_* 變數。");
    } 
    // 其次檢查 Zeabur 自動注入的 MYSQL_ 變數
    else if (process.env.MYSQL_HOST && process.env.MYSQL_USER && process.env.MYSQL_PASSWORD && process.env.MYSQL_DATABASE) {
        dbConfig = {
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
            port: process.env.MYSQL_PORT || 3306,
            charset: 'UTF8MB4_GENERAL_CI',
            timezone: '+08:00'
        };
        console.log("ℹ️ 偵測到 Zeabur 自動注入的 MYSQL_* 變數。");
    } else {
        console.error("❌ 警告：未找到任何完整的 MySQL 連線變數。");
        return;
    }

    try {
        // 建立連線池
        pool = mysql.createPool(dbConfig);
        
        // 🌟 強制執行 SET NAMES，確保連線層級編碼正確
        const connection = await pool.getConnection();
        await connection.query("SET NAMES 'utf8mb4'");
        await connection.query("SET CHARACTER SET utf8mb4");
        connection.release();
        
        console.log('✅ MySQL 資料庫連線池建立成功！');
        
        // 檢查並創建表格 (確保使用 utf8mb4)
        await createTable();
        
    } catch (err) {
        console.error('❌ 資料庫連線或初始化失敗:', err.message);
        pool = null; 
    }
}

async function createTable() {
    if (!pool) return;
    // 確保表格使用 utf8mb4 編碼
    await pool.query(`
        CREATE TABLE IF NOT EXISTS annual_plans (
            id INT AUTO_INCREMENT PRIMARY KEY,
            year INT NOT NULL,
            data JSON NOT NULL,
            theme VARCHAR(50),
            bg_images JSON,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_year (year)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('✅ 資料表 annual_plans 檢查/創建完成 (UTF8MB4)。');
}

connectToDatabase();

// --- 中介軟體 ---
app.use(express.json({ limit: '5mb' }));
app.use(express.raw({ limit: '10mb', type: 'application/octet-stream' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/status', (req, res) => {
    res.send({ status: 'ok', message: 'Cal Planner Backend is running.', dbConnected: !!pool });
});

// --- 徹底重置 API (DROP TABLE) ---
// 這是解決編碼問題的關鍵：刪除舊的 latin1 表格，重建為 utf8mb4
app.delete('/api/test/clear-data', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    try {
        // 1. 刪除表格 (連同舊的編碼定義一起刪除)
        await pool.query(`DROP TABLE IF EXISTS annual_plans;`);
        console.log('⚠️ 已刪除舊表格。');
        
        // 2. 重新建立正確編碼的表格
        await createTable();
        
        return res.json({ success: true, message: '資料庫已徹底重置並升級為 UTF8MB4。' });
    } catch (error) {
        console.error('重置資料失敗:', error.message);
        return res.status(500).json({ error: '執行 DROP/CREATE 失敗。' });
    }
});

// --- 輔助函式：安全解析 JSON ---
function safeParseJson(data) {
    if (typeof data === 'string') {
        try { return JSON.parse(data); } catch (e) { return null; }
    }
    return data; 
}

// --- 資料 CRUD API ---
app.get('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const year = parseInt(req.params.year);
    
    try {
        const [rows] = await pool.query('SELECT data, theme, bg_images FROM annual_plans WHERE year = ?', [year]);
        if (rows.length > 0) {
            const row = rows[0];
            const parsedData = safeParseJson(row.data);
            const parsedBgImages = safeParseJson(row.bg_images);

            if (!parsedData || !parsedBgImages) {
                // 如果解析失敗，回傳 404 讓前端用預設值覆蓋
                return res.status(404).json({ message: `資料損毀` });
            }

            return res.json({
                year: year,
                theme: row.theme,
                yearData: parsedData.yearData,
                monthData: parsedData.monthData,
                backgroundImages: parsedBgImages
            });
        } else {
            return res.status(404).json({ message: `無資料` });
        }
    } catch (error) {
        console.error('讀取失敗:', error.message);
        return res.status(500).json({ error: '伺服器錯誤' });
    }
});

app.post('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const year = parseInt(req.params.year);
    const { yearData, monthData, theme, backgroundImages } = req.body;
    
    if (!yearData || !monthData) return res.status(400).json({ error: '資料不完整' });
    
    const fullData = { yearData, monthData };
    
    try {
        await pool.query(
            `INSERT INTO annual_plans (year, data, theme, bg_images) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE data = VALUES(data), theme = VALUES(theme), bg_images = VALUES(bg_images)`,
            [year, JSON.stringify(fullData), theme, JSON.stringify(backgroundImages)]
        );
        return res.json({ success: true });
    } catch (error) {
        console.error('保存失敗:', error.message);
        return res.status(500).json({ error: '伺服器錯誤' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
