export default async function handler(req, res) {
  const fetchedAt = new Date();
  let rainText = 'กำลังตรวจสอบ';
  let rainPct = null;
  let tmdOk = false;
  try {
    const r = await fetch('https://www.tmd.go.th/forecast/daily', { headers: { 'user-agent': 'Mozilla/5.0' } });
    const html = await r.text();
    const m = html.match(/กรุงเทพและปริมณฑล[\s\S]{0,1500}?ร้อยละ\s*(\d{1,3})/i);
    if (m) { rainPct = Number(m[1]); rainText = `ฝนฟ้าคะนองประมาณ ${rainPct}% ของพื้นที่`; tmdOk = true; }
  } catch (e) {}

  let level = 'orange';
  let levelText = 'เฝ้าระวังค่อนข้างสูง';
  if (rainPct !== null && rainPct <= 20) { level = 'yellow'; levelText = 'เฝ้าระวัง'; }
  if (rainPct !== null && rainPct >= 60) { level = 'red'; levelText = 'เฝ้าระวังสูง'; }

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  res.status(200).json({
    project: 'Villaggio ปิ่นเกล้า–ศาลายา',
    area: 'ต.ศาลากลาง อ.บางกรวย จ.นนทบุรี',
    status: level,
    statusText: levelText,
    rainText,
    rainPct,
    sources: {
      tmd: 'https://www.tmd.go.th/forecast/daily',
      tmdOk
    },
    note: 'ยังไม่พบข้อมูลสาธารณะยืนยันว่าน้ำเข้าภายในหมู่บ้านโดยตรง ข้อมูลนี้เป็นภาพรวมพื้นที่และสภาพอากาศสาธารณะ',
    updatedAt: fetchedAt.toISOString(),
    refreshMinutes: 30
  });
}
