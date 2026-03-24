require('dotenv').config()
const express = require('express')
const cors = require('cors')
const Anthropic = require('@anthropic-ai/sdk')

const app = express()

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean)

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true) // allow postman/server-to-server
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true)
    }
    return callback(new Error('Not allowed by CORS'))
  }
}))

app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ======================================
// แปลงวันที่จากข้อความไทย
// ======================================
function extractDates(msg) {
  const today = new Date()
  const fmt = d => d.toISOString().split('T')[0]
  const add = (d, n) => {
    const x = new Date(d)
    x.setDate(x.getDate() + n)
    return x
  }

  if (msg.match(/วันนี้|คืนนี้|tonight|today/i)) {
    return { checkIn: fmt(today), checkOut: fmt(add(today, 1)) }
  }

  if (msg.match(/พรุ่งนี้|tomorrow/i)) {
    return { checkIn: fmt(add(today, 1)), checkOut: fmt(add(today, 2)) }
  }

  if (msg.match(/สุดสัปดาห์|weekend/i)) {
    const day = today.getDay()
    const sat = add(today, (6 - day + 7) % 7)
    return { checkIn: fmt(sat), checkOut: fmt(add(sat, 1)) }
  }

  const months = {
    มกราคม: 1, กุมภาพันธ์: 2, มีนาคม: 3, เมษายน: 4,
    พฤษภาคม: 5, มิถุนายน: 6, กรกฎาคม: 7, สิงหาคม: 8,
    กันยายน: 9, ตุลาคม: 10, พฤศจิกายน: 11, ธันวาคม: 12
  }

  const match = msg.match(/(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/)

  if (match) {
    const ci = new Date(today.getFullYear(), months[match[2]] - 1, parseInt(match[1], 10))
    return { checkIn: fmt(ci), checkOut: fmt(add(ci, 1)) }
  }

  return { checkIn: fmt(today), checkOut: fmt(add(today, 1)) }
}

// ======================================
// Soraso IBE API — ดึงราคา real-time
// ======================================
async function fetchIBERate({ checkIn, checkOut, hotelCode }) {
  try {
    const res = await fetch(`https://soraso-demo-ibe-api.azurewebsites.net/en/api/v1/Search/Availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'hotelcode': 'SANDBOXONE2'
      },
      body: JSON.stringify({
        Room: 1,
        Arrival: checkIn,
        Departure: checkOut,
        Adult: 1,
        Child: 0,
        Infant: 0
      }),
      signal: AbortSignal.timeout(8000)
    })

    if (!res.ok) {
      console.error(`IBE API responded with ${res.status}`)
      return null
    }

    return await res.json()
  } catch (err) {
    console.error('IBE fetch error:', err.message)
    return null
  }
}

function formatIBERate(data, { checkIn, checkOut }) {
  if (!data || !Array.isArray(data.RoomTypes)) return null

  try {
    const rooms = data.RoomTypes
    const currency = data.Currency || 'THB'

    if (!rooms.length) {
      return `ไม่พบห้องว่างสำหรับวันที่ ${checkIn} ถึง ${checkOut}`
    }

    const lines = rooms.map(room => {
      const roomName = room.RoomTypeName || 'ห้องพัก'
      const capacity = `${room.MaxAdult || 0} ผู้ใหญ่${room.MaxChild > 0 ? `, ${room.MaxChild} เด็ก` : ''}`
      const size = room.RoomSize ? `, ${room.RoomSize} ตร.ม.` : ''

      const ratePlanLines = (room.RatePlans || []).map(plan => {
        const planName = plan.IBERateName || plan.RateName || 'Rate Plan'
        const meal = plan.MealDescription || ''
        const dailyRate = plan.DailyRate?.[0]?.SellRate ?? plan.RoomRate ?? '-'
        const formatted = typeof dailyRate === 'number'
          ? dailyRate.toLocaleString('th-TH')
          : dailyRate

        return `  └─ ${planName}${meal ? ` (${meal})` : ''} — ${formatted} ${currency}/คืน`
      }).join('\n')

      return `• ${roomName} (${capacity}${size})\n${ratePlanLines || '  └─ ไม่พบราคา'}`
    }).join('\n\n')

    return `=== ราคาห้องพัก Real-time จาก Soraso IBE ===
เช็คอิน: ${checkIn} | เช็คเอาท์: ${checkOut}
${lines}`
  } catch (err) {
    console.error('IBE format error:', err.message)
    return null
  }
}

// ======================================
// ดึง context โรงแรม
// ======================================
async function getHotelContext(msg, hotelCode) {
  const m = msg.toLowerCase()
  const ctx = []

  if (m.match(/ราคา|ห้องว่าง|available|จอง|book|วันนี้|พรุ่งนี้|สุดสัปดาห์|weekend|rate|room/i)) {
    const dates = extractDates(msg)
    const ibeData = await fetchIBERate({
      ...dates,
      hotelCode
    })
    const ibeText = formatIBERate(ibeData, dates)
    if (ibeText) ctx.push(ibeText)
  }

  return ctx.join('\n\n')
}

// ======================================
// POST /api/chat
// ======================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], hotelCode, language = 'th' } = req.body

    if (!message?.trim()) {
      return res.status(400).json({ error: 'กรุณาส่งข้อความมาด้วย' })
    }

    const hotelContext = await getHotelContext(message, hotelCode)
    const lang = language === 'en' ? 'English' : 'ภาษาไทย'

    const system = `คุณคือ BOSO ผู้ช่วย AI ของ Soraso Hotel
ตอบเป็น${lang} สุภาพ กระชับ เป็นมิตร และเป็นมืออาชีพ

ข้อมูลที่ใช้ตอบ:
${hotelContext || 'ไม่มีข้อมูลจากระบบในขณะนี้'}

แนวทางการตอบ:
- ตอบกระชับ ชัดเจน ตรงประเด็น
- ถ้าราคามาจาก IBE ให้ระบุว่า "ราคาปัจจุบัน ณ วันนี้"
- ถ้าลูกค้าสนใจจอง แนะนำจองผ่านเว็บไซต์หรือโทร 053-000-003
- ห้ามสร้างข้อมูลที่ไม่มีในระบบ
- ถ้าไม่มีข้อมูล ให้แจ้งอย่างสุภาพว่าจะประสานงานให้
- ใช้ emoji เล็กน้อยเพื่อความเป็นมิตร`

    const response = await claude.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system,
      messages: [
        ...history.slice(-8),
        { role: 'user', content: message }
      ]
    })

    const reply = response?.content?.[0]?.text || 'ขออภัยค่ะ ขณะนี้ไม่สามารถตอบได้'
    res.json({ reply, role: 'assistant' })
  } catch (err) {
    console.error('Chat error:', err)
    res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' })
  }
})

app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', bot: 'BOSO', version: '1.0.0' })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🤖 BOSO Chatbot running on http://localhost:${PORT}`)
})
