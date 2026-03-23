# 🤖 BOSO Chatbot — Soraso Hotel

AI Chatbot สำหรับ Soraso IBE — Clean White Minimal Design

## Stack
- Backend: Node.js + Express
- Database: Supabase (PostgreSQL)
- AI: Claude API (Anthropic)
- IBE: Soraso IBE API (real-time rates)
- Host: Railway

## ไฟล์
```
boso-chatbot/
├── server.js       ← Backend API
├── widget.html     ← Chat widget (ฝังใน IBE ได้เลย)
├── package.json
├── .env.example    ← copy → .env แล้วใส่ค่าจริง
└── README.md
```

## ติดตั้ง
```bash
npm install
cp .env.example .env
# แก้ .env ใส่ค่าจริง
node server.js
```

## Environment Variables
```
ANTHROPIC_API_KEY    = sk-ant-...
SUPABASE_URL         = https://xxx.supabase.co
SUPABASE_ANON_KEY    = eyJ...
SORASO_IBE_URL       = https://soraso-demo-ibe-api.azurewebsites.net
SORASO_HOTEL_CODE    = SANDBOXONE2
ALLOWED_ORIGINS      = https://soraso-ibe-qa.vercel.app,https://web-template1.sorasoone.com
PORT                 = 3000
```

## ฝัง Widget ในเว็บ IBE
copy โค้ด CSS + HTML + JS จาก widget.html ไปวางใน layout หลัก
แล้วเปลี่ยน BOSO_API ให้ตรงกับ Railway URL จริง

```js
const BOSO_API = 'https://boso-chatbot-production.up.railway.app/api/chat'
```

## API
```
POST /api/chat
Body: { "message": "...", "history": [...], "language": "th" | "en" }
Response: { "reply": "...", "role": "assistant" }

GET /api/health
Response: { "status": "ok", "bot": "BOSO", "version": "1.0.0" }
```
