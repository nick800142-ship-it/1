import { useCallback, useEffect, useMemo, useState } from "react";
import type { Asset, Lang } from "@/platform";
import { formatJC, useLanguage } from "@/platform";
import { supabase } from "@/lib/supabase";
import { useVisiblePolling } from "@/hooks/useVisiblePolling";

type Period = "1H" | "1D" | "1W";
type Snapshot = { id: string; price: number; recorded_at: string };
type TradeVolume = { quantity: number; recorded_at: string };
type Candle = {
  time: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type ChartCopy = {
  trend: string; official: string; period: string; latest: string; change: string;
  high: string; low: string; recordCount: string; loading: string; emptyTitle: string;
  emptyDescription: string; selected: string; open: string; highest: string; lowest: string;
  close: string; volume: string; price: string; up: string; down: string;
  volumeLabel: string; clickHint: string; shareUnit: string; accessibleChart: string;
  accessibleCandle: string;
};

const chartCopy: Record<Lang, ChartCopy> = {
  "zh-TW": { trend: "市場走勢", official: "正式紀錄", period: "K 線週期", latest: "最新紀錄價", change: "區間漲跌", high: "區間高點", low: "區間低點", recordCount: "區間紀錄數", loading: "正在讀取價格紀錄…", emptyTitle: "K 線已歸零", emptyDescription: "目前沒有此週期的正式價格紀錄。後台下一次修改並儲存標的價格後，第一筆 K 線才會出現。", selected: "所選 K 線數據", open: "開盤", highest: "最高", lowest: "最低", close: "收盤", volume: "成交量", price: "價格（JC／份）", up: "上漲", down: "下跌", volumeLabel: "成交量", clickHint: "點選圖上的 K 線，即可查看該時段開高低收與成交量", shareUnit: "份", accessibleChart: "{asset} {period} 正式價格 K 線圖，點選蠟燭查看 OHLC 與成交量", accessibleCandle: "{time}，開盤 {open}，最高 {high}，最低 {low}，收盤 {close} JC，成交量 {volume} 份" },
  "zh-CN": { trend: "市场走势", official: "正式记录", period: "K 线周期", latest: "最新记录价", change: "区间涨跌", high: "区间高点", low: "区间低点", recordCount: "区间记录数", loading: "正在读取价格记录…", emptyTitle: "K 线暂无记录", emptyDescription: "当前周期暂无正式价格记录。后台下次修改并保存标的价格后，才会出现第一条 K 线。", selected: "所选 K 线数据", open: "开盘", highest: "最高", lowest: "最低", close: "收盘", volume: "成交量", price: "价格（JC／份）", up: "上涨", down: "下跌", volumeLabel: "成交量", clickHint: "点击图上的 K 线，可查看该时段的开高低收和成交量", shareUnit: "份", accessibleChart: "{asset} {period} 正式价格 K 线图，点击蜡烛查看 OHLC 和成交量", accessibleCandle: "{time}，开盘 {open}，最高 {high}，最低 {low}，收盘 {close} JC，成交量 {volume} 份" },
  en: { trend: "Market trend", official: "Verified records", period: "Candlestick period", latest: "Latest recorded price", change: "Period change", high: "Period high", low: "Period low", recordCount: "Price records", loading: "Loading price history…", emptyTitle: "No candlesticks yet", emptyDescription: "There are no verified price records for this period. The first candle appears after an administrator updates and saves the asset price.", selected: "Selected candle data", open: "Open", highest: "High", lowest: "Low", close: "Close", volume: "Trade volume", price: "Price (JC / share)", up: "Up", down: "Down", volumeLabel: "Volume", clickHint: "Select a candle to view its open, high, low, close, and volume", shareUnit: "shares", accessibleChart: "Verified {period} price candlestick chart for {asset}. Select a candle to view OHLC and volume.", accessibleCandle: "{time}, open {open}, high {high}, low {low}, close {close} JC, volume {volume} shares" },
  ja: { trend: "市場の推移", official: "正式記録", period: "ローソク足の期間", latest: "最新記録価格", change: "期間変動", high: "期間高値", low: "期間安値", recordCount: "期間内の記録数", loading: "価格履歴を読み込み中…", emptyTitle: "ローソク足はまだありません", emptyDescription: "この期間の正式な価格記録はありません。管理者が資産価格を更新して保存すると、最初のローソク足が表示されます。", selected: "選択したローソク足データ", open: "始値", highest: "高値", lowest: "安値", close: "終値", volume: "取引量", price: "価格（JC／口）", up: "上昇", down: "下落", volumeLabel: "取引量", clickHint: "ローソク足を選択すると、始値・高値・安値・終値・取引量を確認できます", shareUnit: "口", accessibleChart: "{asset}の{period}正式価格ローソク足チャート。ローソク足を選択するとOHLCと取引量を確認できます。", accessibleCandle: "{time}、始値 {open}、高値 {high}、安値 {low}、終値 {close} JC、取引量 {volume} 口" },
  ko: { trend: "시장 추이", official: "정식 기록", period: "캔들 기간", latest: "최근 기록 가격", change: "기간 변동", high: "기간 최고가", low: "기간 최저가", recordCount: "기간 기록 수", loading: "가격 기록을 불러오는 중…", emptyTitle: "캔들 기록이 없습니다", emptyDescription: "이 기간에는 정식 가격 기록이 없습니다. 관리자가 자산 가격을 수정하고 저장하면 첫 캔들이 표시됩니다.", selected: "선택한 캔들 데이터", open: "시가", highest: "고가", lowest: "저가", close: "종가", volume: "거래량", price: "가격 (JC / 주)", up: "상승", down: "하락", volumeLabel: "거래량", clickHint: "캔들을 선택해 해당 기간의 시가·고가·저가·종가와 거래량을 확인하세요", shareUnit: "주", accessibleChart: "{asset} {period} 정식 가격 캔들 차트. 캔들을 선택해 OHLC와 거래량을 확인하세요.", accessibleCandle: "{time}, 시가 {open}, 고가 {high}, 저가 {low}, 종가 {close} JC, 거래량 {volume}주" },
  th: { trend: "แนวโน้มตลาด", official: "บันทึกอย่างเป็นทางการ", period: "ช่วงเวลาแท่งเทียน", latest: "ราคาล่าสุดที่บันทึก", change: "การเปลี่ยนแปลงในช่วง", high: "ราคาสูงสุด", low: "ราคาต่ำสุด", recordCount: "จำนวนบันทึกในช่วง", loading: "กำลังโหลดประวัติราคา…", emptyTitle: "ยังไม่มีแท่งเทียน", emptyDescription: "ยังไม่มีบันทึกราคาอย่างเป็นทางการสำหรับช่วงนี้ แท่งแรกจะแสดงหลังผู้ดูแลแก้ไขและบันทึกราคาสินทรัพย์", selected: "ข้อมูลแท่งเทียนที่เลือก", open: "ราคาเปิด", highest: "สูงสุด", lowest: "ต่ำสุด", close: "ราคาปิด", volume: "ปริมาณซื้อขาย", price: "ราคา (JC / หน่วย)", up: "ขึ้น", down: "ลง", volumeLabel: "ปริมาณซื้อขาย", clickHint: "เลือกแท่งเทียนเพื่อดูราคาเปิด สูงสุด ต่ำสุด ปิด และปริมาณซื้อขาย", shareUnit: "หน่วย", accessibleChart: "กราฟแท่งเทียนราคาอย่างเป็นทางการ {period} ของ {asset} เลือกแท่งเพื่อดู OHLC และปริมาณซื้อขาย", accessibleCandle: "{time} เปิด {open} สูงสุด {high} ต่ำสุด {low} ปิด {close} JC ปริมาณซื้อขาย {volume} หน่วย" },
  vi: { trend: "Diễn biến thị trường", official: "Dữ liệu chính thức", period: "Khoảng thời gian nến", latest: "Giá ghi nhận mới nhất", change: "Biến động trong kỳ", high: "Đỉnh trong kỳ", low: "Đáy trong kỳ", recordCount: "Số bản ghi trong kỳ", loading: "Đang tải lịch sử giá…", emptyTitle: "Chưa có nến giá", emptyDescription: "Chưa có dữ liệu giá chính thức trong kỳ này. Nến đầu tiên sẽ xuất hiện sau khi quản trị viên cập nhật và lưu giá tài sản.", selected: "Dữ liệu nến đã chọn", open: "Mở cửa", highest: "Cao nhất", lowest: "Thấp nhất", close: "Đóng cửa", volume: "Khối lượng giao dịch", price: "Giá (JC / phần)", up: "Tăng", down: "Giảm", volumeLabel: "Khối lượng", clickHint: "Chọn một nến để xem giá mở cửa, cao nhất, thấp nhất, đóng cửa và khối lượng", shareUnit: "phần", accessibleChart: "Biểu đồ nến giá chính thức {period} của {asset}. Chọn nến để xem OHLC và khối lượng.", accessibleCandle: "{time}, mở {open}, cao {high}, thấp {low}, đóng {close} JC, khối lượng {volume} phần" },
  id: { trend: "Tren pasar", official: "Catatan resmi", period: "Periode candlestick", latest: "Harga tercatat terbaru", change: "Perubahan periode", high: "Tertinggi periode", low: "Terendah periode", recordCount: "Jumlah catatan", loading: "Memuat riwayat harga…", emptyTitle: "Belum ada candlestick", emptyDescription: "Belum ada catatan harga resmi untuk periode ini. Candlestick pertama akan muncul setelah admin memperbarui dan menyimpan harga aset.", selected: "Data candlestick terpilih", open: "Pembukaan", highest: "Tertinggi", lowest: "Terendah", close: "Penutupan", volume: "Volume perdagangan", price: "Harga (JC / unit)", up: "Naik", down: "Turun", volumeLabel: "Volume", clickHint: "Pilih candlestick untuk melihat harga buka, tertinggi, terendah, tutup, dan volume", shareUnit: "unit", accessibleChart: "Grafik candlestick harga resmi {period} untuk {asset}. Pilih candlestick untuk melihat OHLC dan volume.", accessibleCandle: "{time}, buka {open}, tertinggi {high}, terendah {low}, tutup {close} JC, volume {volume} unit" },
  ms: { trend: "Trend pasaran", official: "Rekod rasmi", period: "Tempoh candlestick", latest: "Harga rekod terkini", change: "Perubahan tempoh", high: "Tertinggi tempoh", low: "Terendah tempoh", recordCount: "Jumlah rekod", loading: "Memuatkan rekod harga…", emptyTitle: "Belum ada candlestick", emptyDescription: "Tiada rekod harga rasmi untuk tempoh ini. Candlestick pertama akan muncul selepas pentadbir mengemas kini dan menyimpan harga aset.", selected: "Data candlestick dipilih", open: "Buka", highest: "Tertinggi", lowest: "Terendah", close: "Tutup", volume: "Jumlah dagangan", price: "Harga (JC / unit)", up: "Naik", down: "Turun", volumeLabel: "Jumlah dagangan", clickHint: "Pilih candlestick untuk melihat harga buka, tertinggi, terendah, tutup dan jumlah dagangan", shareUnit: "unit", accessibleChart: "Carta candlestick harga rasmi {period} untuk {asset}. Pilih candlestick untuk melihat OHLC dan jumlah dagangan.", accessibleCandle: "{time}, buka {open}, tertinggi {high}, terendah {low}, tutup {close} JC, jumlah dagangan {volume} unit" },
  es: { trend: "Tendencia del mercado", official: "Registro oficial", period: "Periodo de velas", latest: "Último precio registrado", change: "Variación del periodo", high: "Máximo del periodo", low: "Mínimo del periodo", recordCount: "Registros del periodo", loading: "Cargando historial de precios…", emptyTitle: "Aún no hay velas", emptyDescription: "No hay registros oficiales de precios para este periodo. La primera vela aparecerá cuando un administrador actualice y guarde el precio del activo.", selected: "Datos de la vela seleccionada", open: "Apertura", highest: "Máximo", lowest: "Mínimo", close: "Cierre", volume: "Volumen negociado", price: "Precio (JC / participación)", up: "Sube", down: "Baja", volumeLabel: "Volumen", clickHint: "Selecciona una vela para consultar apertura, máximo, mínimo, cierre y volumen", shareUnit: "participaciones", accessibleChart: "Gráfico oficial de velas {period} de {asset}. Selecciona una vela para ver OHLC y volumen.", accessibleCandle: "{time}, apertura {open}, máximo {high}, mínimo {low}, cierre {close} JC, volumen {volume} participaciones" },
  fr: { trend: "Tendance du marché", official: "Données officielles", period: "Période des chandeliers", latest: "Dernier prix enregistré", change: "Variation sur la période", high: "Plus haut de la période", low: "Plus bas de la période", recordCount: "Enregistrements de la période", loading: "Chargement de l’historique des prix…", emptyTitle: "Aucun chandelier pour le moment", emptyDescription: "Aucun prix officiel n’est enregistré pour cette période. Le premier chandelier apparaîtra après la mise à jour et l’enregistrement du prix par un administrateur.", selected: "Données du chandelier sélectionné", open: "Ouverture", highest: "Plus haut", lowest: "Plus bas", close: "Clôture", volume: "Volume échangé", price: "Prix (JC / part)", up: "Hausse", down: "Baisse", volumeLabel: "Volume", clickHint: "Sélectionnez un chandelier pour voir l’ouverture, le plus haut, le plus bas, la clôture et le volume", shareUnit: "parts", accessibleChart: "Graphique officiel en chandeliers {period} de {asset}. Sélectionnez un chandelier pour voir OHLC et le volume.", accessibleCandle: "{time}, ouverture {open}, plus haut {high}, plus bas {low}, clôture {close} JC, volume {volume} parts" },
  de: { trend: "Marktentwicklung", official: "Offizielle Aufzeichnungen", period: "Kerzenintervall", latest: "Zuletzt erfasster Preis", change: "Veränderung im Zeitraum", high: "Zeitraumshoch", low: "Zeitraumtief", recordCount: "Datensätze im Zeitraum", loading: "Preisverlauf wird geladen…", emptyTitle: "Noch keine Kurskerzen", emptyDescription: "Für diesen Zeitraum liegen keine offiziellen Preisdaten vor. Die erste Kerze erscheint, sobald ein Administrator den Assetpreis aktualisiert und speichert.", selected: "Daten der ausgewählten Kerze", open: "Eröffnung", highest: "Hoch", lowest: "Tief", close: "Schluss", volume: "Handelsvolumen", price: "Preis (JC / Anteil)", up: "Steigend", down: "Fallend", volumeLabel: "Volumen", clickHint: "Wählen Sie eine Kerze, um Eröffnung, Hoch, Tief, Schluss und Volumen anzuzeigen", shareUnit: "Anteile", accessibleChart: "Offizielles {period}-Kerzendiagramm für {asset}. Kerze auswählen, um OHLC und Volumen anzuzeigen.", accessibleCandle: "{time}, Eröffnung {open}, Hoch {high}, Tief {low}, Schluss {close} JC, Volumen {volume} Anteile" },
  pt: { trend: "Tendência do mercado", official: "Registos oficiais", period: "Período dos candles", latest: "Último preço registado", change: "Variação no período", high: "Máximo do período", low: "Mínimo do período", recordCount: "Registos no período", loading: "A carregar o histórico de preços…", emptyTitle: "Ainda não há candles", emptyDescription: "Não existem registos oficiais de preço neste período. O primeiro candle aparece depois de o administrador atualizar e guardar o preço do ativo.", selected: "Dados do candle selecionado", open: "Abertura", highest: "Máximo", lowest: "Mínimo", close: "Fecho", volume: "Volume negociado", price: "Preço (JC / unidade)", up: "Subida", down: "Descida", volumeLabel: "Volume", clickHint: "Selecione um candle para consultar abertura, máximo, mínimo, fecho e volume", shareUnit: "unidades", accessibleChart: "Gráfico oficial de candles {period} de {asset}. Selecione um candle para ver OHLC e volume.", accessibleCandle: "{time}, abertura {open}, máximo {high}, mínimo {low}, fecho {close} JC, volume {volume} unidades" },
  ru: { trend: "Динамика рынка", official: "Официальные записи", period: "Период свечи", latest: "Последняя записанная цена", change: "Изменение за период", high: "Максимум за период", low: "Минимум за период", recordCount: "Записей за период", loading: "Загрузка истории цен…", emptyTitle: "Свечей пока нет", emptyDescription: "За этот период нет официальных записей цен. Первая свеча появится после того, как администратор обновит и сохранит цену актива.", selected: "Данные выбранной свечи", open: "Открытие", highest: "Максимум", lowest: "Минимум", close: "Закрытие", volume: "Объём торгов", price: "Цена (JC / доля)", up: "Рост", down: "Падение", volumeLabel: "Объём", clickHint: "Выберите свечу, чтобы увидеть открытие, максимум, минимум, закрытие и объём", shareUnit: "долей", accessibleChart: "Официальный график свечей {period} для актива {asset}. Выберите свечу, чтобы увидеть OHLC и объём.", accessibleCandle: "{time}, открытие {open}, максимум {high}, минимум {low}, закрытие {close} JC, объём {volume} долей" },
  ar: { trend: "اتجاه السوق", official: "سجلات رسمية", period: "الفترة الزمنية", latest: "أحدث سعر مسجل", change: "التغير خلال الفترة", high: "أعلى سعر", low: "أدنى سعر", recordCount: "عدد السجلات", loading: "جارٍ تحميل سجل الأسعار…", emptyTitle: "لا توجد شموع سعرية بعد", emptyDescription: "لا توجد سجلات أسعار رسمية لهذه الفترة. ستظهر الشمعة الأولى بعد تحديث المسؤول لسعر الأصل وحفظه.", selected: "بيانات الشمعة المحددة", open: "الافتتاح", highest: "الأعلى", lowest: "الأدنى", close: "الإغلاق", volume: "حجم التداول", price: "السعر (JC / حصة)", up: "ارتفاع", down: "انخفاض", volumeLabel: "الحجم", clickHint: "حدد شمعة لعرض الافتتاح والأعلى والأدنى والإغلاق وحجم التداول", shareUnit: "حصة", accessibleChart: "مخطط الشموع الرسمي {period} للأصل {asset}. حدد شمعة لعرض OHLC وحجم التداول.", accessibleCandle: "{time}، الافتتاح {open}، الأعلى {high}، الأدنى {low}، الإغلاق {close} JC، الحجم {volume} حصة" },
  hi: { trend: "बाज़ार का रुझान", official: "आधिकारिक रिकॉर्ड", period: "कैंडल अवधि", latest: "नवीनतम दर्ज मूल्य", change: "अवधि में बदलाव", high: "अवधि का उच्चतम", low: "अवधि का न्यूनतम", recordCount: "अवधि के रिकॉर्ड", loading: "मूल्य इतिहास लोड हो रहा है…", emptyTitle: "अभी कोई कैंडल नहीं", emptyDescription: "इस अवधि के लिए कोई आधिकारिक मूल्य रिकॉर्ड नहीं है। व्यवस्थापक द्वारा संपत्ति का मूल्य अपडेट और सेव करने के बाद पहली कैंडल दिखाई देगी।", selected: "चुनी गई कैंडल का डेटा", open: "खुला", highest: "उच्चतम", lowest: "न्यूनतम", close: "बंद", volume: "ट्रेड वॉल्यूम", price: "मूल्य (JC / हिस्सा)", up: "बढ़त", down: "गिरावट", volumeLabel: "वॉल्यूम", clickHint: "खुला, उच्चतम, न्यूनतम, बंद और वॉल्यूम देखने के लिए कैंडल चुनें", shareUnit: "हिस्से", accessibleChart: "{asset} का आधिकारिक {period} कैंडल मूल्य चार्ट। OHLC और वॉल्यूम देखने के लिए कैंडल चुनें।", accessibleCandle: "{time}, खुला {open}, उच्चतम {high}, न्यूनतम {low}, बंद {close} JC, वॉल्यूम {volume} हिस्से" },
};

const formatCopy = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((text, [key, value]) => text.replace(`{${key}}`, value), template);

const PERIODS: Record<Period, { range: number; bucket: number }> = {
  "1H": { range: 60 * 60 * 1000, bucket: 5 * 60 * 1000 },
  "1D": { range: 24 * 60 * 60 * 1000, bucket: 60 * 60 * 1000 },
  "1W": { range: 7 * 24 * 60 * 60 * 1000, bucket: 6 * 60 * 60 * 1000 },
};

function bucketByTime<T extends { recorded_at: string }>(
  rows: T[],
  period: Period,
): Map<number, T[]> {
  const { range, bucket } = PERIODS[period];
  const cutoff = Date.now() - range;
  const buckets = new Map<number, T[]>();
  rows
    .filter((row) => new Date(row.recorded_at).getTime() >= cutoff)
    .forEach((row) => {
      const timestamp = new Date(row.recorded_at).getTime();
      const key = Math.floor(timestamp / bucket) * bucket;
      buckets.set(key, [...(buckets.get(key) ?? []), row]);
    });
  return buckets;
}

function aggregateCandles(
  rows: Snapshot[],
  volumes: TradeVolume[],
  period: Period,
): Candle[] {
  const priceBuckets = bucketByTime(rows, period);
  const volumeBuckets = bucketByTime(volumes, period);

  return [...priceBuckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, items]) => {
      const prices = items.map((item) => Number(item.price));
      const volume = (volumeBuckets.get(time) ?? []).reduce(
        (sum, item) => sum + Number(item.quantity),
        0,
      );
      return {
        time: new Date(time),
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        volume,
      };
    });
}

function timeLabel(date: Date, period: Period, language: Lang) {
  return new Intl.DateTimeFormat(language, {
    month: period === "1W" ? "numeric" : undefined,
    day: period === "1W" ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function MarketCandlestickChart({ asset }: { asset: Asset }) {
  const { language } = useLanguage();
  const copy = chartCopy[language];
  const [period, setPeriod] = useState<Period>("1D");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [volumes, setVolumes] = useState<TradeVolume[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const [snapshotResult, volumeResult] = await Promise.all([
      supabase.rpc("get_market_price_snapshots", { asset_key: asset.id }),
      supabase.rpc("get_market_trade_volumes", { asset_key: asset.id }),
    ]);
    if (!snapshotResult.error) setSnapshots((snapshotResult.data ?? []) as Snapshot[]);
    if (!volumeResult.error) setVolumes((volumeResult.data ?? []) as TradeVolume[]);
    setLoading(false);
  }, [asset.id]);
  useVisiblePolling(load, 2_000, true);

  const candles = useMemo(
    () => aggregateCandles(snapshots, volumes, period),
    [snapshots, volumes, period],
  );
  const [selectedIndex, setSelectedIndex] = useState(-1);
  useEffect(() => {
    setSelectedIndex((current) =>
      current < 0 || current >= candles.length ? candles.length - 1 : current,
    );
  }, [candles.length, period]);

  const activeIndex = candles.length ? Math.max(0, Math.min(selectedIndex, candles.length - 1)) : -1;
  const selected = candles[activeIndex] ?? candles[candles.length - 1];
  const high = candles.length ? Math.max(...candles.map((candle) => candle.high)) : 0;
  const low = candles.length ? Math.min(...candles.map((candle) => candle.low)) : 0;
  const latest = candles[candles.length - 1]?.close ?? 0;
  const first = candles[0]?.open ?? 0;
  const change = first > 0 ? ((latest - first) / first) * 100 : 0;
  const recordCount = useMemo(() => {
    const cutoff = Date.now() - PERIODS[period].range;
    return snapshots.filter((row) => new Date(row.recorded_at).getTime() >= cutoff).length;
  }, [snapshots, period]);
  const rawPriceRange = candles.length ? Math.max(high - low, high * 0.01, 0.01) : 1;
  const chartTop = 20;
  const chartHeight = 220;
  const chartMin = low - rawPriceRange * 0.08;
  const chartMax = high + rawPriceRange * 0.08;
  const priceRange = chartMax - chartMin || 1;
  const width = 960;
  const plotWidth = 820;
  const volumeTop = 278;
  const volumeHeight = 48;
  const xStep = candles.length ? plotWidth / candles.length : plotWidth;
  const priceY = (price: number) => chartTop + ((chartMax - price) / priceRange) * chartHeight;
  const maxVolume = Math.max(1, ...candles.map((candle) => candle.volume));
  // 選到最新一根蠟燭時，直接採用與市場卡片相同的權威漲跌幅（asset.change，
  // 由後端依「這筆真實成交價 vs 前一筆真實成交價」計算），確保兩處數字一致；
  // 選到歷史蠟燭時則與前一根蠟燭的收盤價比較，避免同一根蠟燭內開盤／收盤
  // 因時間分桶造成的誤導性數字。
  const isLatestCandle = activeIndex === candles.length - 1;
  const previousCandle = activeIndex > 0 ? candles[activeIndex - 1] : undefined;
  const selectedChange = isLatestCandle
    ? asset.change
    : previousCandle && previousCandle.close
      ? ((selected.close - previousCandle.close) / previousCandle.close) * 100
      : selected?.open
        ? ((selected.close - selected.open) / selected.open) * 100
        : 0;
  const priceTicks = candles.length
    ? Array.from({ length: 5 }, (_, index) => chartMax - (priceRange * index) / 4)
    : [];
  const timeTickIndexes = candles.length
    ? [...new Set([0, Math.floor((candles.length - 1) / 3), Math.floor(((candles.length - 1) * 2) / 3), candles.length - 1])]
    : [];

  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-bold">{copy.trend}</h2>
              <span className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold tracking-wide text-emerald-300">{copy.official}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{asset.name} · JC / {copy.shareUnit}</p>
          </div>
        </div>
        <div className="inline-flex w-fit rounded-lg border border-slate-700 bg-slate-950 p-1" aria-label={copy.period}>
          {(Object.keys(PERIODS) as Period[]).map((item) => (
            <button
              type="button"
              onClick={() => {
                setPeriod(item);
                setSelectedIndex(-1);
              }}
              key={item}
              aria-pressed={period === item}
              className={`min-w-12 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${period === item ? "bg-slate-700 text-white shadow-sm" : "text-slate-400 hover:text-slate-100"}`}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Metric label={copy.latest} value={candles.length ? formatJC(latest) : "—"} />
        <Metric label={copy.change} value={candles.length ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "—"} tone={candles.length ? (change >= 0 ? "up" : "down") : undefined} />
        <Metric label={copy.high} value={candles.length ? formatJC(high) : "—"} />
        <Metric label={copy.low} value={candles.length ? formatJC(low) : "—"} />
        <Metric label={copy.recordCount} value={recordCount.toLocaleString(language)} />
      </div>

      {loading ? (
        <div className="mt-5 flex h-72 items-center justify-center rounded-xl border border-slate-800 bg-slate-950 text-sm text-slate-500">{copy.loading}</div>
      ) : candles.length === 0 ? (
        <div className="mt-5 flex h-72 flex-col items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950 px-6 text-center">
          <p className="font-semibold text-slate-200">{copy.emptyTitle}</p>
          <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-500">{copy.emptyDescription}</p>
        </div>
      ) : (
        <>
          {selected && (
            <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/80 p-3 sm:p-4" aria-live="polite" aria-label={copy.selected}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xl font-semibold tabular-nums text-slate-100">{formatJC(selected.close)}</span>
                  <span className={`rounded-md px-2 py-1 text-xs font-semibold tabular-nums ${selectedChange >= 0 ? "bg-emerald-400/10 text-emerald-300" : "bg-red-400/10 text-red-300"}`}>
                    {selectedChange >= 0 ? "+" : ""}{selectedChange.toFixed(2)}%
                  </span>
                </div>
                <span className="text-xs text-slate-500">{selected.time.toLocaleString(language, { hour12: false })}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Detail label={copy.open} value={selected.open.toFixed(3)} />
                <Detail label={copy.highest} value={selected.high.toFixed(3)} tone="up" />
                <Detail label={copy.lowest} value={selected.low.toFixed(3)} tone="down" />
                <Detail label={copy.close} value={selected.close.toFixed(3)} />
                <Detail label={copy.volume} value={`${selected.volume.toLocaleString(language)} ${copy.shareUnit}`} />
              </div>
            </div>
          )}

          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800 bg-[#0b1220] p-2 pb-1 sm:p-3">
            <div className="min-w-[760px]">
              <div className="mb-1 flex items-center justify-between px-2 text-[11px] text-slate-500">
                <span>{copy.price}</span>
                <span className="flex items-center gap-3"><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-emerald-400" />{copy.up}</span><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-red-400" />{copy.down}</span></span>
              </div>
              <svg viewBox={`0 0 ${width} 360`} className="h-auto w-full select-none" role="group" aria-label={formatCopy(copy.accessibleChart, { asset: asset.name, period })}>
                <defs>
                  <linearGradient id="candle-chart-wash" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="#142033" stopOpacity="0.34" /><stop offset="100%" stopColor="#0b1220" stopOpacity="0" /></linearGradient>
                </defs>
                <rect x="0" y="0" width={plotWidth} height="252" fill="url(#candle-chart-wash)" />
                {priceTicks.map((tick, index) => {
                  const y = chartTop + (chartHeight * index) / 4;
                  return (
                    <g key={`${tick}-${index}`}>
                      <line x1="0" y1={y} x2={plotWidth} y2={y} className="stroke-slate-700/70" strokeDasharray="3 6" />
                      <text x={plotWidth + 12} y={y + 4} className="fill-slate-500 text-[11px] tabular-nums">{tick.toFixed(3)}</text>
                    </g>
                  );
                })}
                <line x1="0" y1={volumeTop - 12} x2={plotWidth} y2={volumeTop - 12} className="stroke-slate-800" />
                <text x="2" y={volumeTop + 1} className="fill-slate-500 text-[10px]">{copy.volumeLabel}</text>
                {candles.map((candle, index) => {
                  const x = index * xStep + xStep / 2;
                  const up = candle.close >= candle.open;
                  const rawBodyHeight = Math.abs(priceY(candle.open) - priceY(candle.close));
                  const bodyHeight = Math.max(4, rawBodyHeight);
                  const bodyTop = priceY(Math.max(candle.open, candle.close)) - Math.max(0, (bodyHeight - rawBodyHeight) / 2);
                  const barWidth = Math.max(5, Math.min(28, xStep * 0.58));
                  const volumeBarHeight = candle.volume > 0 ? Math.max(2, (candle.volume / maxVolume) * volumeHeight) : 0;
                  const candleColor = up ? "text-emerald-400" : "text-red-400";
                  return (
                    <g
                      key={candle.time.toISOString()}
                      role="button"
                      tabIndex={0}
                      aria-pressed={index === activeIndex}
                      aria-label={formatCopy(copy.accessibleCandle, { time: timeLabel(candle.time, period, language), open: candle.open.toFixed(3), high: candle.high.toFixed(3), low: candle.low.toFixed(3), close: candle.close.toFixed(3), volume: candle.volume.toLocaleString(language) })}
                      onClick={() => setSelectedIndex(index)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          setSelectedIndex(index);
                        }
                      }}
                      className="cursor-pointer outline-none"
                    >
                      {index === activeIndex && <rect x={index * xStep} y="8" width={xStep} height={volumeTop + volumeHeight - 2} className="fill-slate-100/[0.035]" />}
                      <line x1={x} y1={priceY(candle.high)} x2={x} y2={priceY(candle.low)} className={`stroke-current ${candleColor}`} strokeWidth="1.5" />
                      <rect x={x - barWidth / 2} y={bodyTop} width={barWidth} height={bodyHeight} rx="1.5" className={`fill-current ${candleColor}`} />
                      {volumeBarHeight > 0 && <rect x={x - barWidth / 2} y={volumeTop + volumeHeight - volumeBarHeight} width={barWidth} height={volumeBarHeight} rx="1" className={`fill-current ${candleColor} opacity-45`} />}
                    </g>
                  );
                })}
                {selected && (() => {
                  const x = activeIndex * xStep + xStep / 2;
                  const y = priceY(selected.close);
                  return (
                    <g pointerEvents="none">
                      <line x1={x} y1={chartTop} x2={x} y2={volumeTop + volumeHeight} className="stroke-slate-400/40" strokeDasharray="3 4" />
                      <line x1="0" y1={y} x2={plotWidth} y2={y} className="stroke-emerald-300/60" strokeDasharray="4 4" />
                      <rect x={plotWidth + 5} y={y - 10} width="76" height="20" rx="4" className="fill-emerald-400" />
                      <text x={plotWidth + 43} y={y + 4} textAnchor="middle" className="fill-slate-950 text-[10px] font-bold tabular-nums">{selected.close.toFixed(3)}</text>
                    </g>
                  );
                })()}
                {timeTickIndexes.map((index) => {
                  const x = index * xStep + xStep / 2;
                  return <text key={index} x={x} y="350" textAnchor={index === 0 ? "start" : index === candles.length - 1 ? "end" : "middle"} className="fill-slate-500 text-[10px] tabular-nums">{timeLabel(candles[index].time, period, language)}</text>;
                })}
              </svg>
            </div>
          </div>
          <p className="mt-2 text-center text-[11px] text-slate-500">{copy.clickHint}</p>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return <div className="rounded-xl bg-slate-950 p-3"><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 text-sm font-bold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-100"}`}>{value}</p></div>;
}

function Detail({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return <div><p className="text-xs text-slate-500">{label}</p><p className={`mt-1 font-semibold ${tone === "up" ? "text-emerald-400" : tone === "down" ? "text-red-400" : "text-slate-200"}`}>{value}</p></div>;
}
