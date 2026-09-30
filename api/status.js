const SWOC = 'https://swoc-api-service.rid.go.th/api';
const PROJECT = {
  name: 'Villaggio ปิ่นเกล้า–ศาลายา',
  area: 'ต.ศาลากลาง อ.บางกรวย จ.นนทบุรี',
  lat: 13.811867,
  lng: 100.341192,
};

function timeoutSignal(ms = 12000) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchJson(url, token) {
  const headers = { 'accept': 'application/json', 'user-agent': 'VillaggioFloodWatch/1.0' };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { headers, signal: timeoutSignal() });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('json')) {
    const text = await r.text();
    try { return JSON.parse(text); } catch { throw new Error('Non-JSON response'); }
  }
  return r.json();
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 VillaggioFloodWatch/1.0', 'accept-language': 'th-TH,th;q=0.9,en;q=0.8' },
    signal: timeoutSignal(),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.text();
}

function flatten(value, out = []) {
  if (Array.isArray(value)) {
    for (const v of value) flatten(v, out);
  } else if (value && typeof value === 'object') {
    out.push(value);
    for (const v of Object.values(value)) if (v && typeof v === 'object') flatten(v, out);
  }
  return out;
}

function stringify(o) {
  try { return JSON.stringify(o).toLowerCase(); } catch { return ''; }
}

function pickNonthaburi(data) {
  return flatten(data).filter(o => {
    const s = stringify(o);
    return s.includes('นนทบุรี') || s.includes('nonthaburi');
  });
}

function numFromObject(o, keyHints) {
  for (const [k, v] of Object.entries(o || {})) {
    const lk = k.toLowerCase();
    if (keyHints.some(h => lk.includes(h))) {
      const n = Number(String(v).replace(/,/g, ''));
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseRainPctFromTmdHtml(html) {
  const m = html.match(/กรุงเทพ(?:มหานคร)?และปริมณฑล[\s\S]{0,1800}?ร้อยละ\s*(\d{1,3})/i)
    || html.match(/กรุงเทพ(?:มหานคร)?[\s\S]{0,1800}?ร้อยละ\s*(\d{1,3})/i);
  return m ? Number(m[1]) : null;
}

function summarizeForecast(records) {
  if (!records?.length) return null;
  const first = records[0];
  const rain = numFromObject(first, ['rain', 'precip', 'percent', 'chance']);
  const tempMax = numFromObject(first, ['maxtemp', 'temp_max', 'tmax']);
  const tempMin = numFromObject(first, ['mintemp', 'temp_min', 'tmin']);
  return { rain, tempMax, tempMin, raw: first };
}

function summarizeRain3h(records) {
  if (!records?.length) return null;
  let max = null, chosen = null;
  for (const r of records) {
    const n = numFromObject(r, ['rain', 'rf', 'amount', 'precip']);
    if (n != null && (max == null || n > max)) { max = n; chosen = r; }
  }
  return max == null ? { raw: records[0] } : { maxMm: max, raw: chosen };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

function nearestInfrastructure(data) {
  const rows = flatten(data);
  let best = null;
  for (const r of rows) {
    const lat = numFromObject(r, ['lat', 'latitude']);
    const lng = numFromObject(r, ['lng', 'lon', 'long', 'longitude']);
    if (lat == null || lng == null || lat < 5 || lat > 22 || lng < 95 || lng > 106) continue;
    const km = haversine(PROJECT.lat, PROJECT.lng, lat, lng);
    if (!best || km < best.distanceKm) best = { distanceKm: km, raw: r };
  }
  return best;
}

function assess({ rainPct, rain3hMm, swocForecastOk, tmdOk, infrasOk, damOk }) {
  let score = 1; // baseline: area already requires monitoring in this event
  const reasons = [];
  if (rainPct != null) {
    if (rainPct >= 60) { score += 2; reasons.push(`โอกาสฝนสูง ${rainPct}%`); }
    else if (rainPct >= 40) { score += 1; reasons.push(`มีโอกาสฝน ${rainPct}%`); }
  }
  if (rain3hMm != null) {
    if (rain3hMm >= 35) { score += 2; reasons.push(`ฝน 3 ชม. สูงสุดที่พบ ${rain3hMm} มม.`); }
    else if (rain3hMm >= 15) { score += 1; reasons.push(`มีฝนสะสม 3 ชม. ${rain3hMm} มม.`); }
  }
  const liveCount = [swocForecastOk, tmdOk, infrasOk, damOk].filter(Boolean).length;
  if (score >= 4) return { status:'red', statusText:'เฝ้าระวังสูง', reasons, liveCount };
  if (score >= 2) return { status:'orange', statusText:'เฝ้าระวังค่อนข้างสูง', reasons, liveCount };
  return { status:'yellow', statusText:'เฝ้าระวัง', reasons, liveCount };
}

export default async function handler(req, res) {
  const fetchedAt = new Date();
  const token = process.env.SWOC_TOKEN || '';

  const urls = {
    swocForecast: `${SWOC}/rainfall-tmd-7fcst-province/`,
    swocRain3h: `${SWOC}/rainfall-tmd-3hr-data/`,
    infras: `${SWOC}/infras-data/`,
    dam: `${SWOC}/dam-data/`,
    tmdDaily: 'https://www.tmd.go.th/forecast/daily',
  };

  const result = {
    project: PROJECT.name,
    area: PROJECT.area,
    coordinates: { lat: PROJECT.lat, lng: PROJECT.lng },
    rainPct: null,
    rainText: 'กำลังตรวจสอบข้อมูลฝน',
    rainfall3hMm: null,
    nearestInfrastructure: null,
    forecast: null,
    sourceHealth: {},
  };

  const calls = await Promise.allSettled([
    fetchJson(urls.swocForecast, token),
    fetchJson(urls.swocRain3h, token),
    fetchJson(urls.infras, token),
    fetchJson(urls.dam, token),
    fetchText(urls.tmdDaily),
  ]);

  const [forecastR, rain3hR, infrasR, damR, tmdR] = calls;

  result.sourceHealth.swocForecast = forecastR.status === 'fulfilled';
  result.sourceHealth.swocRain3h = rain3hR.status === 'fulfilled';
  result.sourceHealth.swocInfrastructure = infrasR.status === 'fulfilled';
  result.sourceHealth.swocDam = damR.status === 'fulfilled';
  result.sourceHealth.tmdDaily = tmdR.status === 'fulfilled';

  if (forecastR.status === 'fulfilled') {
    const rows = pickNonthaburi(forecastR.value);
    result.forecast = summarizeForecast(rows);
    if (result.forecast?.rain != null && result.forecast.rain >= 0 && result.forecast.rain <= 100) {
      result.rainPct = result.forecast.rain;
    }
  }

  if (rain3hR.status === 'fulfilled') {
    const rows = pickNonthaburi(rain3hR.value);
    const s = summarizeRain3h(rows);
    result.rainfall3hMm = s?.maxMm ?? null;
  }

  if (infrasR.status === 'fulfilled') {
    const n = nearestInfrastructure(infrasR.value);
    if (n) result.nearestInfrastructure = {
      distanceKm: Math.round(n.distanceKm * 10) / 10,
      data: n.raw,
    };
  }

  if (tmdR.status === 'fulfilled') {
    const pct = parseRainPctFromTmdHtml(tmdR.value);
    if (pct != null) result.rainPct = pct; // official daily forecast takes priority for the headline
  }

  if (result.rainPct != null) {
    result.rainText = `กรมอุตุฯ: โอกาสฝนประมาณ ${result.rainPct}% ของพื้นที่`;
    if (result.rainfall3hMm != null) result.rainText += ` • SWOC ฝน 3 ชม. สูงสุดที่พบในนนทบุรี ${result.rainfall3hMm} มม.`;
  } else if (result.rainfall3hMm != null) {
    result.rainText = `SWOC: ฝนสะสม 3 ชม. สูงสุดที่พบในนนทบุรี ${result.rainfall3hMm} มม.`;
  } else {
    result.rainText = 'ยังดึงตัวเลขฝนล่าสุดไม่ได้ — แสดงสถานะเฝ้าระวังจากข้อมูลพื้นที่แทน';
  }

  const risk = assess({
    rainPct: result.rainPct,
    rain3hMm: result.rainfall3hMm,
    swocForecastOk: result.sourceHealth.swocForecast,
    tmdOk: result.sourceHealth.tmdDaily,
    infrasOk: result.sourceHealth.swocInfrastructure,
    damOk: result.sourceHealth.swocDam,
  });

  const health = Object.values(result.sourceHealth);
  const online = health.filter(Boolean).length;
  const total = health.length;

  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=300');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).json({
    ...result,
    status: risk.status,
    statusText: risk.statusText,
    riskReasons: risk.reasons,
    apiSummary: `${online}/${total} แหล่งข้อมูลเชื่อมต่อสำเร็จ`,
    note: 'เป็นการประเมินจากข้อมูลสาธารณะของ TMD และ SWOC/RID ไม่ใช่เซนเซอร์ระดับน้ำภายในหมู่บ้าน จึงไม่สามารถยืนยันน้ำหน้าบ้านแบบเรียลไทม์ได้',
    sources: urls,
    updatedAt: fetchedAt.toISOString(),
    refreshMinutes: 30,
  });
}
