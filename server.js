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
            charset: 'UTF8MB4_GENERAL_CI',
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
        pool = mysql.createPool(dbConfig);
        
        const connection = await pool.getConnection();
        await connection.query("SET NAMES 'utf8mb4'");
        await connection.query("SET CHARACTER SET utf8mb4");
        connection.release();
        
        console.log('✅ MySQL 資料庫連線池建立成功！');
        await createTable();
        
    } catch (err) {
        console.error('❌ 資料庫連線或初始化失敗:', err.message);
        pool = null; 
    }
}

async function createTable() {
    if (!pool) return;
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

// --- 中介軟體 (提升限制以支援圖片上傳) ---
// 🌟 修正：將限制提升至 50MB，解決多張圖片導致儲存失敗的問題
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ limit: '50mb', type: 'application/octet-stream' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/status', (req, res) => {
    res.send({ status: 'ok', message: 'Cal Planner Backend is running.', dbConnected: !!pool });
});

// --- 徹底重置 API ---
app.delete('/api/test/clear-data', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    try {
        await pool.query(`DROP TABLE IF EXISTS annual_plans;`);
        await createTable();
        return res.json({ success: true, message: '資料庫已徹底重置。' });
    } catch (error) {
        console.error('重置資料失敗:', error.message);
        return res.status(500).json({ error: '執行失敗。' });
    }
});

// --- 全庫備份與還原 API ---
// 1. 備份：下載所有年份資料
app.get('/api/db/backup', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    try {
        const [rows] = await pool.query('SELECT * FROM annual_plans');
        // 將資料庫原始資料直接回傳
        res.setHeader('Content-Disposition', 'attachment; filename="database_backup.json"');
        res.setHeader('Content-Type', 'application/json');
        return res.json(rows);
    } catch (error) {
        console.error('備份失敗:', error.message);
        return res.status(500).json({ error: '備份失敗' });
    }
});

// 2. 還原：上傳 JSON 並覆蓋資料庫
app.post('/api/db/restore', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const backupData = req.body; // 預期是一個陣列
    
    if (!Array.isArray(backupData)) {
        return res.status(400).json({ error: '格式錯誤：備份檔案應為陣列' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        // 清空現有表格
        await connection.query('TRUNCATE TABLE annual_plans');
        
        // 逐筆插入還原資料
        for (const row of backupData) {
            // 處理 JSON 欄位可能是字串或物件的情況
            const dataStr = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
            const bgStr = typeof row.bg_images === 'string' ? row.bg_images : JSON.stringify(row.bg_images);
            
            await connection.query(
                `INSERT INTO annual_plans (year, data, theme, bg_images, created_at) VALUES (?, ?, ?, ?, ?)`,
                [row.year, dataStr, row.theme, bgStr, new Date(row.created_at)]
            );
        }
        
        await connection.commit();
        return res.json({ success: true, message: `成功還原 ${backupData.length} 筆年度資料` });
    } catch (error) {
        await connection.rollback();
        console.error('還原失敗:', error.message);
        return res.status(500).json({ error: `還原失敗: ${error.message}` });
    } finally {
        connection.release();
    }
});

// --- 輔助函式 ---
function safeParseJson(data) {
    if (typeof data === 'string') {
        try { return JSON.parse(data); } catch (e) { return null; }
    }
    return data; 
}

// --- 單一年份 CRUD ---
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
