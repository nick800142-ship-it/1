import type { Lang } from "@/platform";

export const legacyUiCopy: Partial<Record<Lang, Record<string, string>>> = {
  en: {
    "訂單狀態": "Order status", "鏈上託管": "On-chain escrow", "賣單・價格／剩餘份額": "Sell orders · price / remaining", "買單・價格／剩餘份額": "Buy orders · price / remaining", "目前沒有掛單": "No orders", "掛買單": "Place buy order", "掛賣單": "Place sell order", "可用 JC": "Available JC", "持有份額": "Holdings", "單位價格（JC）": "Unit price (JC)", "訂單數量": "Order quantity", "訂單總額": "Order total", "確認後份額會直接鎖在鏈上託管合約；收取一次性 1 JC 掛單費（取消不退），成交再收 1%。": "After confirmation, shares are locked in on-chain escrow; a one-time 1 JC listing fee applies (non-refundable), plus a 1% settlement fee.", "找不到符合條件的二級市場標的": "No matching secondary-market assets", "總代理": "Master agent", "最近申請": "Recent application", "我的推廣碼": "My referral code", "更新推廣碼": "Update referral code", "代理與推廣關係": "Agency and referral relationship", "設定": "Settings", "一般": "General", "通知": "Notifications", "外觀": "Appearance", "語言": "Language", "淺色": "Light", "深色": "Dark", "跟隨系統": "System", "儲存": "Save", "知道了": "Got it", "送出申請": "Submit application"
  },
  ko: {
    "訂單狀態": "주문 상태", "鏈上託管": "온체인 에스크로", "賣單・價格／剩餘份額": "매도 주문 · 가격 / 잔여 수량", "買單・價格／剩餘份額": "매수 주문 · 가격 / 잔여 수량", "目前沒有掛單": "주문이 없습니다", "掛買單": "매수 주문", "掛賣單": "매도 주문", "可用 JC": "사용 가능 JC", "持有份額": "보유 수량", "單位價格（JC）": "단가 (JC)", "訂單數量": "주문 수량", "訂單總額": "주문 총액", "找不到符合條件的二級市場標的": "조건에 맞는 2차 시장 자산이 없습니다", "總代理": "마스터 에이전트", "最近申請": "최근 신청", "我的推廣碼": "내 추천 코드", "更新推廣碼": "추천 코드 업데이트", "設定": "설정", "語言": "언어", "淺色": "밝은 테마", "深色": "어두운 테마", "跟隨系統": "시스템 설정", "送出申請": "신청 제출"
  },
  hi: {
    "訂單狀態": "ऑर्डर स्थिति", "鏈上託管": "ऑन-चेन एस्क्रो", "賣單・價格／剩餘份額": "बिक्री ऑर्डर · कीमत / शेष मात्रा", "買單・價格／剩餘份額": "खरीद ऑर्डर · कीमत / शेष मात्रा", "目前沒有掛單": "कोई ऑर्डर नहीं", "掛買單": "खरीद ऑर्डर", "掛賣單": "बिक्री ऑर्डर", "可用 JC": "उपलब्ध JC", "持有份額": "होल्डिंग", "單位價格（JC）": "इकाई मूल्य (JC)", "訂單數量": "ऑर्डर मात्रा", "訂單總額": "ऑर्डर कुल", "找不到符合條件的二級市場標的": "फ़िल्टर से मेल खाने वाली कोई द्वितीयक बाज़ार संपत्ति नहीं है", "總代理": "मास्टर एजेंट", "最近申請": "हाल का आवेदन", "我的推廣碼": "मेरा रेफ़रल कोड", "更新推廣碼": "रेफ़रल कोड अपडेट करें", "設定": "सेटिंग्स", "語言": "भाषा", "淺色": "हल्का", "深色": "गहरा", "跟隨系統": "सिस्टम", "送出申請": "आवेदन भेजें", "知道了": "समझ गया"
  }
};

export function getLegacyText(language: Lang, fallback: string) {
  return legacyUiCopy[language]?.[fallback] ?? fallback;
}
