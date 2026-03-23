require('dotenv').config()
const express = require('express')
const cors = require('cors')
const Anthropic = require('@anthropic-ai/sdk')
const { createClient } = require('@supabase/supabase-js')

const app = express()

// CORS — รองรับทั้งสองเว็บ
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)
app.use(cors())
app.use(express.json())

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)

// ======================================
// Soraso IBE API — ดึงราคา real-time
// ======================================
async function fetchIBERate({ checkIn, checkOut, adults = 2, children = 0 }) {
  try {
    const res = await fetch(`${process.env.SORASO_IBE_URL}/en/api/v1/Search/Availability`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'hotelcode': process.env.SORASO_HOTEL_CODE
      },
      body: JSON.stringify({
        Room: 1,
        Arrival: checkIn,
        Departure: checkOut,
        Adult: adults,
        Child: children,
        Infant: 0
      }),
      signal: AbortSignal.timeout(8000) // timeout 8 วินาที
    })

    if (!res.ok) {
      console.error(`IBE API responded with ${res.status}`)
      return null
    }

    const data = await res.json()
    return data
  } catch (err) {
    console.error('IBE fetch error:', err.message)
    return null
  }
}

function formatIBERate(data, checkIn, checkOut) {
  if (!data) return null

  try {
    // รองรับหลาย format ที่ IBE อาจส่งมา
    const rooms = Array.isArray(data)
      ? data
      : data.RoomTypes || data.rooms || data.results || data.data || []

    if (!rooms.length) {
      return `ไม่พบห้องว่างสำหรับวันที่ ${checkIn} ถึง ${checkOut}`
    }

    const lines = rooms.map(r => {
      const name = r.RoomTypeName || r.RoomName || r.name || 'ห้องพัก'
      const rate = r.Rate || r.TotalRate || r.ratePerNight || r.price || '-'
      const currency = r.Currency || r.currency || 'THB'
      const formatted = typeof rate === 'number' ? rate.toLocaleString() : rate
      return `• ${name} — ${formatted} ${currency}/คืน`
    }).join('\n')

    return `=== ราคาห้องพัก Real-time จาก Soraso IBE ===\nเช็คอิน: ${checkIn} | เช็คเอาท์: ${checkOut}\n\n${lines}`
  } catch (err) {
    console.error('IBE format error:', err.message)
    return null
  }
}

// ======================================
// แปลงวันที่จากข้อความไทย
// ======================================
function extractDates(msg) {
  const today = new Date()
  const fmt = d => d.toISOString().split('T')[0]
  const add = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }

  if (msg.match(/วันนี้|คืนนี้|tonight|today/i)) return { checkIn: fmt(today), checkOut: fmt(add(today, 1)) }
  if (msg.match(/พรุ่งนี้|tomorrow/i)) return { checkIn: fmt(add(today, 1)), checkOut: fmt(add(today, 2)) }
  if (msg.match(/สุดสัปดาห์|weekend/i)) {
    const day = today.getDay()
    const sat = add(today, 6 - day)
    return { checkIn: fmt(sat), checkOut: fmt(add(sat, 1)) }
  }

  // ค้นหาวันที่จากข้อความ เช่น "25 มีนาคม"
  const months = { มกราคม:1,กุมภาพันธ์:2,มีนาคม:3,เมษายน:4,พฤษภาคม:5,มิถุนายน:6,กรกฎาคม:7,สิงหาคม:8,กันยายน:9,ตุลาคม:10,พฤศจิกายน:11,ธันวาคม:12 }
  const match = msg.match(/(\d{1,2})\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/)
  if (match) {
    const ci = new Date(today.getFullYear(), months[match[2]] - 1, parseInt(match[1]))
    return { checkIn: fmt(ci), checkOut: fmt(add(ci, 1)) }
  }

  // default → วันนี้ถึงพรุ่งนี้
  return { checkIn: fmt(today), checkOut: fmt(add(today, 1)) }
}

// ======================================
// Supabase — ดึงข้อมูลโรงแรม
// ======================================
async function getHotelContext(msg) {
  const m = msg.toLowerCase()
  const ctx = []

  // ดึงราคา real-time จาก IBE
  if (m.match(/ราคา|ห้องว่าง|available|จอง|book|วันนี้|พรุ่งนี้|สุดสัปดาห์|weekend|rate|room/i)) {
    const dates = extractDates(msg)
    const ibeData = await fetchIBERate(dates)
    const ibeText = formatIBERate(ibeData, dates.checkIn, dates.checkOut)
    if (ibeText) ctx.push(ibeText)
  }

  // ดึงข้อมูลห้องพักจาก Supabase (รายละเอียดเพิ่มเติม)
  if (m.match(/ห้อง|พัก|room|suite|deluxe|standard|superior|family/i)) {
    const { data: rooms } = await supabase.from('rooms').select('*').eq('available', true).order('price_per_night')
    if (rooms?.length) {
      ctx.push(`=== รายละเอียดห้องพัก ===\n` + rooms.map(r =>
        `• ${r.name} | ${r.price_per_night?.toLocaleString()} บาท/คืน | ${r.capacity} คน | ${r.size_sqm} ตร.ม.\n  ${r.description}\n  สิ่งอำนวยความสะดวก: ${r.amenities?.join(', ')}`
      ).join('\n\n'))
    }
  }

  // บริการ
  if (m.match(/บริการ|สระ|สปา|ฟิตเนส|อาหาร|รถ|สนามบิน|service|pool|spa|gym|restaurant|transport/i)) {
    const { data: services } = await supabase.from('services').select('*').eq('available', true)
    if (services?.length) {
      ctx.push(`=== บริการของโรงแรม ===\n` + services.map(s =>
        `• ${s.name} | ${s.hours} | ${s.price ? `${s.price} บาท` : 'ฟรี'}\n  ${s.description}`
      ).join('\n\n'))
    }
  }

  // FAQ
  if (m.match(/เช็คอิน|เช็คเอาท์|ยกเลิก|จอดรถ|wifi|บัตร|สัตว์|check|cancel|pet|park|นโยบาย|policy/i)) {
    const { data: faqs } = await supabase.from('faqs').select('*')
    if (faqs?.length) {
      ctx.push(`=== FAQ & นโยบายโรงแรม ===\n` + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n'))
    }
  }

  // โปรโมชัน
  if (m.match(/โปร|ส่วนลด|ลด|discount|promotion|offer|deal|special/i)) {
    const today = new Date().toISOString().split('T')[0]
    const { data: promos } = await supabase.from('promotions').select('*')
      .eq('active', true).lte('valid_from', today).gte('valid_until', today)
    if (promos?.length) {
      ctx.push(`=== โปรโมชันที่มีอยู่ตอนนี้ ===\n` + promos.map(p =>
        `• ${p.title}${p.discount_percent > 0 ? ` (ลด ${p.discount_percent}%)` : ''}\n  ${p.description}\n  เงื่อนไข: ${p.conditions}`
      ).join('\n\n'))
    }
  }

  // fallback — FAQ
  if (!ctx.length) {
    const { data: faqs } = await supabase.from('faqs').select('*')
    if (faqs?.length) ctx.push(`=== FAQ & นโยบายโรงแรม ===\n` + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n'))
  }

  return ctx.join('\n\n')
}

// ======================================
// POST /api/chat
// ======================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history = [], hotelCode, language = 'th' } = req.body

    if (!message?.trim()) return res.status(400).json({ error: 'กรุณาส่งข้อความมาด้วย' })

    const hotelContext = await getHotelContext(message)
    const lang = language === 'en' ? 'English' : 'ภาษาไทย'

    const system = `คุณคือ BOSO ผู้ช่วย AI ของ Soraso Hotel
ตอบเป็น${lang} สุภาพ กระชับ เป็นมิตร และเป็นมืออาชีพ
ใช้ข้อมูลด้านล่างในการตอบเท่านั้น หากไม่มีข้อมูลให้บอกว่าจะประสานงานให้

${hotelContext}

แนวทางการตอบ:
- ตอบกระชับ ชัดเจน ตรงประเด็น
- ถ้าราคามาจาก IBE ให้ระบุว่า "ราคาปัจจุบัน ณ วันนี้"
- ถ้าลูกค้าสนใจจอง แนะนำจองผ่านเว็บไซต์หรือโทร 053-000-000
- ห้ามสร้างข้อมูลที่ไม่มีในระบบ
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

    res.json({ reply: response.content[0].text, role: 'assistant' })

  } catch (err) {
    console.error('Chat error:', err.message)
    res.status(500).json({ error: 'เกิดข้อผิดพลาด กรุณาลองใหม่' })
  }
})

app.get('/api/health', (_, res) => res.json({ status: 'ok', bot: 'BOSO', version: '1.0.0' }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🤖 BOSO Chatbot running on http://localhost:${PORT}`))
