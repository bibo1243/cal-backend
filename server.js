const express = require('express');
const { Client } = require('@notionhq/client');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = 3000;

// ==========================================
// CONFIGURATION (請在此填入你的 Notion 資訊)
// ==========================================
const NOTION_API_KEY = '你的_NOTION_SECRET_KEY_貼在這裡'; 
const NOTION_DATABASE_ID = '你的_DATABASE_ID_貼在這裡';

// ==========================================
// 系統資訊與更新日誌
// ==========================================
const APP_INFO = {
    version: '1.1.1',
    lastUpdated: '2023-10-27',
    changelog: [
        { date: '2023-10-27', content: '修復：修正 server.js 中的語法錯誤 (SyntaxError)' },
        { date: '2023-10-27', content: '新增：版本號與更新日誌顯示功能' },
        { date: '2023-10-27', content: '修復：關聯計畫 (Relation) 無法顯示的問題' },
        { date: '2023-10-26', content: '新增：基礎任務增刪改查功能' }
    ]
};

const notion = new Client({ auth: NOTION_API_KEY });

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// ==========================================
// API ROUTES
// ==========================================

// 1. 查詢所有任務 (含關聯欄位讀取)
app.get('/api/tasks', async (req, res) => {
    try {
        const response = await notion.databases.query({
            database_id: NOTION_DATABASE_ID,
            sorts: [
                {
                    property: 'Date',
                    direction: 'ascending',
                },
            ],
        });

        const tasks = response.results.map(page => {
            // 嘗試讀取關聯欄位 (假設你的 Notion 欄位名稱叫 "Linked")
            // 如果你的欄位叫 "Yearly Plan"，請將下方的 'Linked' 改為 'Yearly Plan'
            const relations = page.properties['Linked']?.relation || []; 
            const hasRelation = relations.length > 0;

            return {
                id: page.id,
                title: page.properties.Name.title[0]?.plain_text || '無標題',
                status: page.properties.Status.select?.name || page.properties.Status.status?.name || 'To Do',
                date: page.properties.Date.date?.start || '無日期',
                relationCount: relations.length,
                relationId: hasRelation ? relations[0].id : null
            };
        });

        res.json(tasks);
    } catch (error) {
        console.error('讀取失敗:', error.body || error);
        res.status(500).json({ error: '無法讀取 Notion 資料' });
    }
});

// 2. 新增任務
app.post('/api/tasks', async (req, res) => {
    const { title, date, status } = req.body;
    try {
        const response = await notion.pages.create({
            parent: { database_id: NOTION_DATABASE_ID },
            properties: {
                Name: { title: [{ text: { content: title } }] },
                Date: { date: { start: date } },
                Status: { select: { name: status || 'To Do' } }
            },
        });
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '無法新增任務' });
    }
});

// 3. 更新任務狀態
app.patch('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    const { status } = req.body;
    try {
        const response = await notion.pages.update({
            page_id: id,
            properties: { Status: { select: { name: status } } },
        });
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '無法更新任務' });
    }
});

// 4. 刪除任務
app.delete('/api/tasks/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const response = await notion.pages.update({
            page_id: id,
            archived: true,
        });
        res.json(response);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: '無法刪除任務' });
    }
});

// 5. 取得系統資訊 API
app.get('/api/info', (req, res) => {
    res.json(APP_INFO);
});

// ==========================================
// FRONTEND
// ==========================================
app.get('/', (req, res) => {
    const infoScript = `const SERVER_INFO = ${JSON.stringify(APP_INFO)};`;

    res.send(`
    <!DOCTYPE html>
    <html lang="zh-TW">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Notion 任務管理器 v${APP_INFO.version}</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 1000px; margin: 0 auto; padding: 20px; background-color: #f7f7f7; display: flex; gap: 20px; }
            .main-content { flex: 3; }
            .sidebar { flex: 1; }
            h1 { color: #37352f; }
            .card { background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); margin-bottom: 20px; }
            input, select, button { padding: 10px; margin: 5px 0; width: 100%; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
            button { background-color: #000; color: white; cursor: pointer; border: none; font-weight: bold; }
            button:hover { background-color: #333; }
            .task-item { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; padding: 15px 0; }
            .task-info { flex-grow: 1; }
            .task-title { font-weight: bold; font-size: 1.1em; }
            .task-meta { font-size: 0.9em; color: #666; margin-top: 4px; }
            .task-actions { display: flex; gap: 10px; align-items: center; }
            .status-badge { padding: 4px 8px; border-radius: 4px; font-size: 0.8em; margin-right: 10px; }
            .status-todo { background: #ffe2dd; color: #d44c47; }
            .status-inprogress { background: #fdecc8; color: #d9730d; }
            .status-done { background: #dbeddb; color: #2eaadc; }
            .relation-badge { background: #e3e2e0; color: #505558; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-left: 5px; }
            .btn-sm { width: auto; padding: 5px 10px; font-size: 0.8em; }
            .btn-delete { background-color: #ff4d4f; }
            .version-tag { background: #2383e2; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; vertical-align: middle; }
            .changelog-item { border-bottom: 1px solid #eee; padding: 10px 0; font-size: 0.9em; }
            .changelog-date { color: #888; font-size: 0.8em; margin-bottom: 2px; }
        </style>
    </head>
    <body>
        <div class="main-content">
            <h1>📝 Notion 任務管理器 <span class="version-tag">v${APP_INFO.version}</span></h1>
            <div class="card">
                <h3>新增任務</h3>
                <input type="text" id="newTitle" placeholder="任務名稱" required>
                <input type="date" id="newDate" required>
                <select id="newStatus">
                    <option value="To Do">To Do (待辦)</option>
                    <option value="In Progress">In Progress (進行中)</option>
                    <option value="Done">Done (完成)</option>
                </select>
                <button onclick="addTask()">新增至 Notion</button>
            </div>
            <div class="card">
                <h3>任務列表</h3>
                <div id="taskList">載入中...</div>
            </div>
        </div>
        <div class="sidebar">
            <div class="card">
                <h3>🚀 版本資訊</h3>
                <p>目前版本：<strong>v${APP_INFO.version}</strong></p>
                <p>更新時間：${APP_INFO.lastUpdated}</p>
            </div>
            <div class="card">
                <h3>📅 更新日誌</h3>
                <div id="changelogList"></div>
            </div>
            <div class="card">
                <h3>💡 提示</h3>
                <p style="font-size: 0.9em; color: #666;">
                    若要顯示關聯，請確保 Notion 資料庫中有一個名為 <b>Linked</b> 的 Relation 欄位。
                </p>
            </div>
        </div>
        <script>
            ${infoScript}
            const API_URL = 'http://localhost:3000/api/tasks';

            function renderChangelog() {
                const list = document.getElementById('changelogList');
                SERVER_INFO.changelog.forEach(log => {
                    list.innerHTML += \`
                        <div class="changelog-item">
                            <div class="changelog-date">\${log.date}</div>
                            <div>\${log.content}</div>
                        </div>
                    \`;
                });
            }

            async function loadTasks() {
                const list = document.getElementById('taskList');
                list.innerHTML = '載入中...';
                try {
                    const res = await fetch(API_URL);
                    const tasks = await res.json();
                    
                    list.innerHTML = '';
                    tasks.forEach(task => {
                        const div = document.createElement('div');
                        div.className = 'task-item';
                        
                        let statusClass = 'status-todo';
                        if(task.status === 'In Progress') statusClass = 'status-inprogress';
                        if(task.status === 'Done') statusClass = 'status-done';

                        const relationHtml = task.relationCount > 0 
                            ? \`<span class="relation-badge">🔗 已關聯 \${task.relationCount} 個計畫</span>\` 
                            : '';

                        div.innerHTML = \`
                            <div class="task-info">
                                <div class="task-title">
                                    \${task.title}
                                    \${relationHtml}
                                </div>
                                <div class="task-meta">📅 \${task.date} <span class="status-badge \${statusClass}">\${task.status}</span></div>
                            </div>
                            <div class="task-actions">
                                <select onchange="updateStatus('\${task.id}', this.value)" class="btn-sm">
                                    <option value="To Do" \${task.status === 'To Do' ? 'selected' : ''}>To Do</option>
                                    <option value="In Progress" \${task.status === 'In Progress' ? 'selected' : ''}>In Progress</option>
                                    <option value="Done" \${task.status === 'Done' ? 'selected' : ''}>Done</option>
                                </select>
                                <button class="btn-sm btn-delete" onclick="deleteTask('\${task.id}')">刪除</button>
                            </div>
                        \`;
                        list.appendChild(div);
                    });
                } catch (e) {
                    list.innerHTML = '載入失敗，請檢查後端 Console';
                    console.error(e);
                }
            }

            async function addTask() {
                const title = document.getElementById('newTitle').value;
                const date = document.getElementById('newDate').value;
                const status = document.getElementById('newStatus').value;

                if(!title || !date) return alert('請填寫完整資訊');

                await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ title, date, status })
                });

                document.getElementById('newTitle').value = '';
                loadTasks();
            }

            async function updateStatus(id, newStatus) {
                await fetch(\`\${API_URL}/\${id}\`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: newStatus })
                });
                loadTasks();
            }

            async function deleteTask(id) {
                if(!confirm('確定要刪除嗎？')) return;
                await fetch(\`\${API_URL}/\${id}\`, {
                    method: 'DELETE'
                });
                loadTasks();
            }

            renderChangelog();
            loadTasks();
        </script>
    </body>
    </html>
    `);
});

app.listen(PORT, () => {
    console.log(`伺服器已啟動: http://localhost:${PORT}`);
    console.log(`版本: ${APP_INFO.version}`);
});
