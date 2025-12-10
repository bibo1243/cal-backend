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
    
    // 檢查環境變數 (優先順序：手動 DB_ > Zeabur MYSQL_)
    if (process.env.DB_HOST) {
        dbConfig = {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASS,
            database: process.env.DB_NAME,
            port: process.env.MYSQL_PORT || 3306,
            charset: 'UTF8MB4_GENERAL_CI',
            timezone: '+08:00'
        };
    } else if (process.env.MYSQL_HOST) {
        dbConfig = {
            host: process.env.MYSQL_HOST,
            user: process.env.MYSQL_USER,
            password: process.env.MYSQL_PASSWORD,
            database: process.env.MYSQL_DATABASE,
            port: process.env.MYSQL_PORT || 3306,
            charset: 'UTF8MB4_GENERAL_CI',
            timezone: '+08:00'
        };
    } else {
        console.error("❌ 警告：未找到任何完整的 MySQL 連線變數。");
        return;
    }

    try {
        pool = mysql.createPool(dbConfig);
        
        // 強制設定連線編碼
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
    // 使用 JSON 欄位來儲存靈活的資料結構 (包含青蛙、關聯、圖片)
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
    console.log('✅ 資料表 annual_plans 檢查/創建完成。');
}

connectToDatabase();

// --- 中介軟體 (50MB 限制) ---
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ limit: '50mb', type: 'application/octet-stream' }));
app.use(express.static(PUBLIC_DIR));

app.get('/api/status', (req, res) => {
    res.send({ status: 'ok', message: 'Cal Planner Backend is running.', dbConnected: !!pool });
});

// --- 清空資料庫 API ---
app.delete('/api/test/clear-data', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    try {
        await pool.query(`DROP TABLE IF EXISTS annual_plans;`);
        await createTable();
        return res.json({ success: true, message: '資料庫已重置。' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// --- 備份與還原 API ---
app.get('/api/db/backup', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    try {
        const [rows] = await pool.query('SELECT * FROM annual_plans');
        res.setHeader('Content-Disposition', 'attachment; filename="database_backup.json"');
        return res.json(rows);
    } catch (error) {
        return res.status(500).json({ error: '備份失敗' });
    }
});

app.post('/api/db/restore', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const backupData = req.body;
    if (!Array.isArray(backupData)) return res.status(400).json({ error: '格式錯誤' });

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        await connection.query('TRUNCATE TABLE annual_plans');
        for (const row of backupData) {
            const dataStr = typeof row.data === 'string' ? row.data : JSON.stringify(row.data);
            const bgStr = typeof row.bg_images === 'string' ? row.bg_images : JSON.stringify(row.bg_images);
            await connection.query(
                `INSERT INTO annual_plans (year, data, theme, bg_images, created_at) VALUES (?, ?, ?, ?, ?)`,
                [row.year, dataStr, row.theme, bgStr, new Date(row.created_at)]
            );
        }
        await connection.commit();
        return res.json({ success: true });
    } catch (error) {
        await connection.rollback();
        return res.status(500).json({ error: error.message });
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

// --- 年度資料 CRUD ---
app.get('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const year = parseInt(req.params.year);
    
    try {
        const [rows] = await pool.query('SELECT data, theme, bg_images FROM annual_plans WHERE year = ?', [year]);
        if (rows.length > 0) {
            const row = rows[0];
            return res.json({
                year: year,
                theme: row.theme,
                yearData: safeParseJson(row.data).yearData, // 確保結構正確
                monthData: safeParseJson(row.data).monthData,
                backgroundImages: safeParseJson(row.bg_images)
            });
        } else {
            return res.status(404).json({ message: `無資料` });
        }
    } catch (error) {
        console.error("讀取失敗", error);
        return res.status(500).json({ error: '伺服器錯誤' });
    }
});

app.post('/api/plan/:year', async (req, res) => {
    if (!pool) return res.status(503).json({ error: '資料庫離線' });
    const year = parseInt(req.params.year);
    const { yearData, monthData, theme, backgroundImages } = req.body;
    
    // 將 yearData 和 monthData 包裝在一個 JSON 物件中
    const fullData = { yearData, monthData };
    
    try {
        await pool.query(
            `INSERT INTO annual_plans (year, data, theme, bg_images) VALUES (?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE data = VALUES(data), theme = VALUES(theme), bg_images = VALUES(bg_images)`,
            [year, JSON.stringify(fullData), theme, JSON.stringify(backgroundImages)]
        );
        return res.json({ success: true });
    } catch (error) {
        console.error("保存失敗", error);
        return res.status(500).json({ error: '伺服器錯誤' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
