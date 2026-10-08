import { useState } from "react";
import useSWR from "swr";
import { Link2, RefreshCw, Send, Unlink } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Lang } from "@/platform";

type TelegramCopyKey = "title" | "loading" | "unavailable" | "connected" | "notConnected" | "connectedAccount" | "connectHelp" | "connectedAt" | "readError" | "botMissing" | "working" | "change" | "connect" | "disconnect" | "linkInstructions" | "linkReplace" | "linkExpiry" | "openTelegram" | "checkStatus" | "unlinkWarning" | "confirmUnlink" | "cancel" | "typesTitle" | "typesHint" | "marketAlerts" | "commissionUpdates" | "partialFills" | "orderCompleted" | "connectedSuccess" | "pending" | "refreshError" | "disconnectedSuccess" | "requestError";
const telegramCopyKeys: TelegramCopyKey[] = ["title", "loading", "unavailable", "connected", "notConnected", "connectedAccount", "connectHelp", "connectedAt", "readError", "botMissing", "working", "change", "connect", "disconnect", "linkInstructions", "linkReplace", "linkExpiry", "openTelegram", "checkStatus", "unlinkWarning", "confirmUnlink", "cancel", "typesTitle", "typesHint", "marketAlerts", "commissionUpdates", "partialFills", "orderCompleted", "connectedSuccess", "pending", "refreshError", "disconnectedSuccess", "requestError"];
const telegramCopy: Record<Lang, string[]> = {
  "zh-TW": ["Telegram 通知", "載入中", "無法讀取", "已連結", "未連結", "已連結 Telegram 私人帳號", "連結 Telegram 後，可在 Telegram 接收帳戶與資產通知。", "連結時間：", "無法讀取 Telegram 設定，請重新整理或稍後再試。", "Telegram Bot 尚未完成設定，目前無法建立連結。", "處理中…", "更換 Telegram", "連結 Telegram", "解除連結", "請使用要綁定的 Telegram 帳號開啟連結，並在 Bot 對話中按下 Start。", "完成驗證後，新帳號會取代目前連結；若該 Telegram 已屬於其他平台帳號，原帳號也會解除連結。", "連結 10 分鐘後失效。", "開啟 Telegram 完成綁定", "我已完成，檢查狀態", "解除後，這個平台帳號將不再透過 Telegram 接收通知；之後仍可重新連結。", "確認解除", "取消", "Telegram 通知類型", "各項通知可獨立開關，變更會立即儲存。", "市場價格／新項目通知", "收益分配通知", "二級市場部分成交", "掛單完成通知", "Telegram 已成功連結。", "尚未偵測到完成綁定，請在 Telegram 按下 Start 後再試。", "狀態更新失敗，請稍後重試。", "Telegram 已解除連結。", "設定未完成，請稍後再試。"],
  "zh-CN": ["Telegram 通知", "加载中", "无法读取", "已连接", "未连接", "已连接 Telegram 私人账号", "连接 Telegram 后，可在 Telegram 接收账户与资产通知。", "连接时间：", "无法读取 Telegram 设置，请刷新或稍后再试。", "Telegram Bot 尚未完成设置，目前无法创建连接。", "处理中…", "更换 Telegram", "连接 Telegram", "断开连接", "请使用要绑定的 Telegram 账号打开链接，并在 Bot 对话中点击 Start。", "验证完成后，新账号将替换当前连接；如果此 Telegram 已关联其他平台账号，该账号也会解除连接。", "链接 10 分钟后失效。", "打开 Telegram 完成绑定", "我已完成，检查状态", "断开后，此平台账号将不再通过 Telegram 接收通知；之后仍可重新连接。", "确认断开", "取消", "Telegram 通知类型", "各项通知可独立开关，变更后立即保存。", "市场价格／新项目通知", "收益分配通知", "二级市场部分成交", "挂单完成通知", "Telegram 已成功连接。", "尚未检测到完成绑定，请在 Telegram 点击 Start 后再试。", "状态更新失败，请稍后重试。", "Telegram 已断开连接。", "设置未完成，请稍后再试。"],
  en: ["Telegram notifications", "Loading", "Unavailable", "Connected", "Not connected", "A Telegram account is connected", "Connect Telegram to receive account and asset alerts there.", "Connected: ", "Could not load Telegram settings. Please retry.", "The Telegram bot is not configured, so a link cannot be created yet.", "Working…", "Change Telegram", "Connect Telegram", "Disconnect", "Open this link with the Telegram account you want to connect, then tap Start in the bot chat.", "After verification, this replaces the current connection. If this Telegram account belongs to another platform account, that connection will also be removed.", "The link expires in 10 minutes.", "Open Telegram to connect", "I finished, check status", "Disconnecting stops Telegram notifications for this platform account. You can reconnect later.", "Confirm disconnect", "Cancel", "Telegram notification types", "Control each notification independently. Changes save immediately.", "Market, price and new project alerts", "Commission updates", "Partial order fills", "Order completed", "Telegram is connected.", "Connection is not complete yet. Tap Start in Telegram, then check again.", "Could not refresh the connection status.", "Telegram has been disconnected.", "The request could not be completed. Please try again."],
  ja: ["Telegram通知", "読み込み中", "読み込めません", "連携済み", "未連携", "Telegramの個人アカウントを連携済み", "Telegramを連携すると、アカウントや資産の通知を受け取れます。", "連携日時：", "Telegram設定を読み込めません。再読み込みして再度お試しください。", "Telegram Botが未設定のため、連携リンクを作成できません。", "処理中…", "Telegramを変更", "Telegramを連携", "連携を解除", "連携するTelegramアカウントでリンクを開き、Botとの会話でStartを押してください。", "認証後、新しいアカウントが現在の連携に置き換わります。他のプラットフォームアカウントに連携済みの場合、その連携も解除されます。", "リンクは10分後に期限切れになります。", "Telegramを開いて連携", "完了しました。状態を確認", "解除すると、このアカウントはTelegram通知を受け取れなくなります。後から再連携できます。", "連携解除を確認", "キャンセル", "Telegram通知の種類", "通知ごとに個別設定でき、変更はすぐ保存されます。", "市場価格・新規案件の通知", "報酬分配の通知", "二次市場の部分約定", "注文完了の通知", "Telegramを連携しました。", "連携が確認できません。TelegramでStartを押してから再度確認してください。", "状態を更新できませんでした。", "Telegramの連携を解除しました。", "処理に失敗しました。しばらくしてから再度お試しください。"],
  ko: ["Telegram 알림", "불러오는 중", "불러올 수 없음", "연결됨", "연결되지 않음", "Telegram 개인 계정이 연결되어 있습니다", "Telegram을 연결하면 계정 및 자산 알림을 받을 수 있습니다.", "연결 시간: ", "Telegram 설정을 불러올 수 없습니다. 새로고침하거나 잠시 후 다시 시도하세요.", "Telegram Bot이 설정되지 않아 연결 링크를 만들 수 없습니다.", "처리 중…", "Telegram 변경", "Telegram 연결", "연결 해제", "연결할 Telegram 계정으로 링크를 열고 Bot 대화에서 Start를 누르세요.", "인증 후 새 계정이 현재 연결을 대체합니다. 이 Telegram이 다른 플랫폼 계정에 연결되어 있으면 해당 연결도 해제됩니다.", "링크는 10분 후 만료됩니다.", "Telegram을 열어 연결", "완료했어요. 상태 확인", "연결을 해제하면 이 플랫폼 계정은 Telegram 알림을 받지 않습니다. 나중에 다시 연결할 수 있습니다.", "연결 해제 확인", "취소", "Telegram 알림 유형", "알림을 각각 설정할 수 있으며 변경 사항은 즉시 저장됩니다.", "시장 가격 및 신규 프로젝트 알림", "분배금 알림", "2차 시장 부분 체결", "주문 완료 알림", "Telegram이 연결되었습니다.", "연결이 완료되지 않았습니다. Telegram에서 Start를 누른 뒤 다시 확인하세요.", "상태를 새로고침하지 못했습니다.", "Telegram 연결이 해제되었습니다.", "요청을 완료하지 못했습니다. 잠시 후 다시 시도하세요."],
  th: ["การแจ้งเตือน Telegram", "กำลังโหลด", "ไม่พร้อมใช้งาน", "เชื่อมต่อแล้ว", "ยังไม่เชื่อมต่อ", "เชื่อมต่อบัญชี Telegram ส่วนตัวแล้ว", "เชื่อมต่อ Telegram เพื่อรับการแจ้งเตือนบัญชีและสินทรัพย์", "เวลาเชื่อมต่อ: ", "โหลดการตั้งค่า Telegram ไม่ได้ โปรดลองใหม่", "ยังไม่ได้ตั้งค่า Telegram Bot จึงสร้างลิงก์ไม่ได้", "กำลังดำเนินการ…", "เปลี่ยน Telegram", "เชื่อมต่อ Telegram", "ยกเลิกการเชื่อมต่อ", "เปิดลิงก์ด้วยบัญชี Telegram ที่ต้องการเชื่อมต่อ แล้วกด Start ในแชตกับ Bot", "หลังยืนยัน บัญชีใหม่นี้จะแทนที่บัญชีเดิม หาก Telegram นี้เชื่อมกับบัญชีอื่น ระบบจะยกเลิกการเชื่อมต่อเดิมด้วย", "ลิงก์หมดอายุใน 10 นาที", "เปิด Telegram เพื่อเชื่อมต่อ", "เสร็จแล้ว ตรวจสอบสถานะ", "เมื่อยกเลิกการเชื่อมต่อ บัญชีนี้จะไม่ได้รับการแจ้งเตือนผ่าน Telegram และสามารถเชื่อมต่อใหม่ได้", "ยืนยันการยกเลิก", "ยกเลิก", "ประเภทการแจ้งเตือน Telegram", "ตั้งค่าการแจ้งเตือนแต่ละรายการได้ และบันทึกทันที", "ราคาและโครงการใหม่", "การแบ่งปันรายได้", "การจับคู่คำสั่งบางส่วน", "คำสั่งซื้อขายเสร็จสมบูรณ์", "เชื่อมต่อ Telegram แล้ว", "ยังไม่พบการเชื่อมต่อ โปรดกด Start ใน Telegram แล้วตรวจสอบอีกครั้ง", "อัปเดตสถานะไม่สำเร็จ", "ยกเลิกการเชื่อมต่อ Telegram แล้ว", "ดำเนินการไม่สำเร็จ โปรดลองอีกครั้ง"],
  vi: ["Thông báo Telegram", "Đang tải", "Không khả dụng", "Đã kết nối", "Chưa kết nối", "Đã kết nối tài khoản Telegram cá nhân", "Kết nối Telegram để nhận thông báo tài khoản và tài sản.", "Thời gian kết nối: ", "Không thể tải cài đặt Telegram. Vui lòng thử lại.", "Bot Telegram chưa được cấu hình nên chưa thể tạo liên kết.", "Đang xử lý…", "Đổi Telegram", "Kết nối Telegram", "Ngắt kết nối", "Mở liên kết bằng tài khoản Telegram muốn kết nối, sau đó nhấn Start trong cuộc trò chuyện với Bot.", "Sau khi xác minh, tài khoản mới sẽ thay thế liên kết hiện tại. Nếu Telegram này thuộc tài khoản nền tảng khác, liên kết đó cũng sẽ bị gỡ.", "Liên kết hết hạn sau 10 phút.", "Mở Telegram để kết nối", "Tôi đã hoàn tất, kiểm tra trạng thái", "Ngắt kết nối sẽ dừng thông báo Telegram cho tài khoản này. Bạn có thể kết nối lại sau.", "Xác nhận ngắt kết nối", "Hủy", "Loại thông báo Telegram", "Có thể bật/tắt từng thông báo riêng; thay đổi được lưu ngay.", "Giá thị trường và dự án mới", "Cập nhật hoa hồng", "Khớp một phần lệnh", "Lệnh đã hoàn tất", "Đã kết nối Telegram.", "Chưa hoàn tất kết nối. Hãy nhấn Start trong Telegram rồi kiểm tra lại.", "Không thể làm mới trạng thái.", "Đã ngắt kết nối Telegram.", "Không thể hoàn tất yêu cầu. Vui lòng thử lại."],
  id: ["Notifikasi Telegram", "Memuat", "Tidak tersedia", "Terhubung", "Belum terhubung", "Akun pribadi Telegram terhubung", "Hubungkan Telegram untuk menerima notifikasi akun dan aset.", "Waktu terhubung: ", "Pengaturan Telegram tidak dapat dimuat. Silakan coba lagi.", "Bot Telegram belum dikonfigurasi sehingga tautan belum dapat dibuat.", "Memproses…", "Ganti Telegram", "Hubungkan Telegram", "Putuskan koneksi", "Buka tautan menggunakan akun Telegram yang ingin dihubungkan, lalu tekan Start di chat Bot.", "Setelah verifikasi, akun baru menggantikan koneksi saat ini. Jika Telegram ini terhubung ke akun platform lain, koneksi tersebut juga akan dilepas.", "Tautan kedaluwarsa dalam 10 menit.", "Buka Telegram untuk menghubungkan", "Saya sudah selesai, periksa status", "Memutus koneksi akan menghentikan notifikasi Telegram untuk akun ini. Anda dapat menghubungkannya kembali nanti.", "Konfirmasi putuskan koneksi", "Batal", "Jenis notifikasi Telegram", "Atur setiap notifikasi secara terpisah. Perubahan langsung tersimpan.", "Harga pasar dan proyek baru", "Pembaruan komisi", "Order terisi sebagian", "Order selesai", "Telegram terhubung.", "Koneksi belum selesai. Tekan Start di Telegram lalu periksa kembali.", "Status gagal diperbarui.", "Telegram telah diputuskan.", "Permintaan gagal. Silakan coba lagi."],
  ms: ["Pemberitahuan Telegram", "Memuatkan", "Tidak tersedia", "Disambungkan", "Belum disambungkan", "Akaun peribadi Telegram disambungkan", "Sambungkan Telegram untuk menerima pemberitahuan akaun dan aset.", "Masa sambungan: ", "Tetapan Telegram tidak dapat dimuatkan. Sila cuba lagi.", "Bot Telegram belum dikonfigurasi, jadi pautan belum boleh dibuat.", "Sedang diproses…", "Tukar Telegram", "Sambungkan Telegram", "Putuskan sambungan", "Buka pautan menggunakan akaun Telegram yang ingin disambungkan, kemudian tekan Start dalam chat Bot.", "Selepas pengesahan, akaun baharu akan menggantikan sambungan semasa. Jika Telegram ini milik akaun platform lain, sambungan itu juga akan diputuskan.", "Pautan tamat tempoh selepas 10 minit.", "Buka Telegram untuk menyambung", "Saya sudah selesai, semak status", "Memutuskan sambungan menghentikan pemberitahuan Telegram untuk akaun ini. Anda boleh menyambung semula kemudian.", "Sahkan putuskan sambungan", "Batal", "Jenis pemberitahuan Telegram", "Setiap pemberitahuan boleh ditetapkan secara berasingan dan perubahan disimpan serta-merta.", "Harga pasaran dan projek baharu", "Kemas kini komisen", "Pesanan diisi sebahagian", "Pesanan selesai", "Telegram telah disambungkan.", "Sambungan belum selesai. Tekan Start di Telegram dan semak semula.", "Gagal mengemas kini status.", "Telegram telah diputuskan.", "Permintaan gagal. Sila cuba lagi."],
  es: ["Notificaciones de Telegram", "Cargando", "No disponible", "Conectado", "Sin conectar", "Hay una cuenta personal de Telegram conectada", "Conecta Telegram para recibir allí avisos de cuenta y activos.", "Conectado: ", "No se pudo cargar la configuración de Telegram. Inténtalo de nuevo.", "El bot de Telegram no está configurado y no se puede crear un enlace.", "Procesando…", "Cambiar Telegram", "Conectar Telegram", "Desconectar", "Abre el enlace con la cuenta de Telegram que quieras conectar y pulsa Start en el chat del bot.", "Tras verificarla, la nueva cuenta sustituirá la conexión actual. Si esta cuenta de Telegram pertenece a otra cuenta de la plataforma, también se desvinculará.", "El enlace caduca en 10 minutos.", "Abrir Telegram para conectar", "Ya terminé, comprobar estado", "Al desconectar, esta cuenta dejará de recibir avisos por Telegram. Podrás volver a conectarla más tarde.", "Confirmar desconexión", "Cancelar", "Tipos de notificación de Telegram", "Configura cada aviso por separado. Los cambios se guardan al instante.", "Precios y nuevos proyectos", "Actualizaciones de comisiones", "Ejecuciones parciales", "Orden completada", "Telegram está conectado.", "La conexión no está completa. Pulsa Start en Telegram y vuelve a comprobarlo.", "No se pudo actualizar el estado.", "Telegram se ha desconectado.", "No se pudo completar la solicitud. Inténtalo de nuevo."],
  fr: ["Notifications Telegram", "Chargement", "Indisponible", "Connecté", "Non connecté", "Un compte Telegram personnel est connecté", "Connectez Telegram pour recevoir les alertes de compte et d’actifs.", "Connecté le : ", "Impossible de charger les paramètres Telegram. Veuillez réessayer.", "Le bot Telegram n’est pas configuré ; le lien ne peut pas être créé.", "Traitement…", "Changer Telegram", "Connecter Telegram", "Déconnecter", "Ouvrez ce lien avec le compte Telegram à connecter, puis appuyez sur Start dans la conversation avec le bot.", "Après vérification, le nouveau compte remplacera la connexion actuelle. Si ce Telegram appartient à un autre compte de la plateforme, cette connexion sera également supprimée.", "Le lien expire dans 10 minutes.", "Ouvrir Telegram pour connecter", "J’ai terminé, vérifier l’état", "La déconnexion arrête les notifications Telegram pour ce compte. Vous pourrez le reconnecter plus tard.", "Confirmer la déconnexion", "Annuler", "Types de notifications Telegram", "Chaque notification est réglable séparément et les modifications sont enregistrées immédiatement.", "Prix et nouveaux projets", "Mises à jour des commissions", "Exécutions partielles", "Ordre terminé", "Telegram est connecté.", "La connexion n’est pas terminée. Appuyez sur Start dans Telegram, puis réessayez.", "Impossible d’actualiser l’état.", "Telegram a été déconnecté.", "La demande a échoué. Veuillez réessayer."],
  de: ["Telegram-Benachrichtigungen", "Wird geladen", "Nicht verfügbar", "Verbunden", "Nicht verbunden", "Ein persönliches Telegram-Konto ist verbunden", "Verbinde Telegram, um Konto- und Asset-Benachrichtigungen zu erhalten.", "Verbunden am: ", "Telegram-Einstellungen konnten nicht geladen werden. Bitte erneut versuchen.", "Der Telegram-Bot ist nicht eingerichtet; es kann kein Link erstellt werden.", "Wird verarbeitet…", "Telegram ändern", "Telegram verbinden", "Verbindung trennen", "Öffne den Link mit dem Telegram-Konto, das du verbinden möchtest, und tippe im Bot-Chat auf Start.", "Nach der Bestätigung ersetzt das neue Konto die aktuelle Verbindung. Gehört dieses Telegram-Konto zu einem anderen Plattformkonto, wird auch dessen Verbindung aufgehoben.", "Der Link läuft nach 10 Minuten ab.", "Telegram zum Verbinden öffnen", "Fertig, Status prüfen", "Nach dem Trennen erhält dieses Plattformkonto keine Telegram-Benachrichtigungen mehr. Eine erneute Verbindung ist möglich.", "Trennung bestätigen", "Abbrechen", "Telegram-Benachrichtigungstypen", "Jede Benachrichtigung lässt sich einzeln steuern. Änderungen werden sofort gespeichert.", "Marktpreise und neue Projekte", "Provisionsupdates", "Teilfüllungen", "Order abgeschlossen", "Telegram ist verbunden.", "Die Verbindung ist noch nicht vollständig. Tippe in Telegram auf Start und prüfe erneut.", "Status konnte nicht aktualisiert werden.", "Telegram wurde getrennt.", "Anfrage fehlgeschlagen. Bitte erneut versuchen."],
  pt: ["Notificações do Telegram", "A carregar", "Indisponível", "Ligado", "Não ligado", "Uma conta pessoal do Telegram está ligada", "Ligue o Telegram para receber notificações de conta e ativos.", "Ligado em: ", "Não foi possível carregar as definições do Telegram. Tente novamente.", "O bot do Telegram não está configurado e não é possível criar uma ligação.", "A processar…", "Alterar Telegram", "Ligar Telegram", "Desligar", "Abra a ligação com a conta Telegram que pretende associar e prima Start na conversa com o bot.", "Após a verificação, a nova conta substitui a ligação atual. Se este Telegram pertencer a outra conta da plataforma, essa ligação também será removida.", "A ligação expira em 10 minutos.", "Abrir Telegram para ligar", "Já terminei, verificar estado", "Ao desligar, esta conta deixa de receber notificações do Telegram. Pode voltar a ligá-la mais tarde.", "Confirmar desligamento", "Cancelar", "Tipos de notificações do Telegram", "Configure cada notificação separadamente. As alterações são guardadas de imediato.", "Preços e novos projetos", "Atualizações de comissões", "Execuções parciais", "Ordem concluída", "Telegram ligado.", "A ligação ainda não está concluída. Prima Start no Telegram e verifique novamente.", "Não foi possível atualizar o estado.", "Telegram desligado.", "Não foi possível concluir o pedido. Tente novamente."],
  ru: ["Уведомления Telegram", "Загрузка", "Недоступно", "Подключено", "Не подключено", "Подключён личный аккаунт Telegram", "Подключите Telegram, чтобы получать уведомления об аккаунте и активах.", "Подключено: ", "Не удалось загрузить настройки Telegram. Попробуйте снова.", "Бот Telegram не настроен, поэтому ссылку создать нельзя.", "Обработка…", "Сменить Telegram", "Подключить Telegram", "Отключить", "Откройте ссылку в аккаунте Telegram, который нужно подключить, и нажмите Start в чате с ботом.", "После проверки новый аккаунт заменит текущее подключение. Если этот Telegram принадлежит другому аккаунту платформы, его подключение также будет удалено.", "Ссылка истечёт через 10 минут.", "Открыть Telegram для подключения", "Готово, проверить статус", "После отключения этот аккаунт перестанет получать уведомления Telegram. Подключение можно восстановить позже.", "Подтвердить отключение", "Отмена", "Типы уведомлений Telegram", "Каждое уведомление настраивается отдельно; изменения сохраняются сразу.", "Рыночные цены и новые проекты", "Обновления комиссий", "Частичное исполнение ордера", "Ордер исполнен", "Telegram подключён.", "Подключение не завершено. Нажмите Start в Telegram и проверьте снова.", "Не удалось обновить статус.", "Telegram отключён.", "Не удалось выполнить запрос. Попробуйте снова."],
  ar: ["إشعارات Telegram", "جارٍ التحميل", "غير متاح", "متصل", "غير متصل", "تم ربط حساب Telegram شخصي", "اربط Telegram لتلقي إشعارات الحساب والأصول هناك.", "وقت الربط: ", "تعذر تحميل إعدادات Telegram. يرجى المحاولة مرة أخرى.", "لم يتم إعداد بوت Telegram، لذا لا يمكن إنشاء رابط.", "جارٍ التنفيذ…", "تغيير Telegram", "ربط Telegram", "قطع الاتصال", "افتح الرابط باستخدام حساب Telegram الذي تريد ربطه، ثم اضغط Start في محادثة البوت.", "بعد التحقق، سيحل الحساب الجديد محل الاتصال الحالي. إذا كان هذا الحساب مرتبطًا بحساب آخر على المنصة، فسيتم إلغاء ذلك الاتصال أيضًا.", "تنتهي صلاحية الرابط بعد 10 دقائق.", "فتح Telegram للربط", "انتهيت، تحقق من الحالة", "سيؤدي قطع الاتصال إلى إيقاف إشعارات Telegram لهذا الحساب. يمكنك إعادة الربط لاحقًا.", "تأكيد قطع الاتصال", "إلغاء", "أنواع إشعارات Telegram", "يمكن التحكم في كل إشعار بشكل مستقل، وتُحفظ التغييرات فورًا.", "أسعار السوق والمشاريع الجديدة", "تحديثات العمولات", "تنفيذ جزئي للطلب", "اكتمل الطلب", "تم ربط Telegram.", "لم يكتمل الربط. اضغط Start في Telegram ثم تحقق مرة أخرى.", "تعذر تحديث الحالة.", "تم قطع اتصال Telegram.", "تعذر إكمال الطلب. يرجى المحاولة مجددًا."],
  hi: ["Telegram सूचनाएँ", "लोड हो रहा है", "उपलब्ध नहीं", "कनेक्टेड", "कनेक्ट नहीं है", "Telegram निजी खाता कनेक्ट है", "खाता और संपत्ति संबंधी सूचनाएँ पाने के लिए Telegram कनेक्ट करें।", "कनेक्शन समय: ", "Telegram सेटिंग लोड नहीं हुई। कृपया फिर प्रयास करें।", "Telegram Bot कॉन्फ़िगर नहीं है, इसलिए लिंक नहीं बनाया जा सकता।", "प्रक्रिया जारी…", "Telegram बदलें", "Telegram कनेक्ट करें", "डिस्कनेक्ट करें", "जिस Telegram खाते को जोड़ना है उससे लिंक खोलें और Bot चैट में Start दबाएँ।", "सत्यापन के बाद नया खाता मौजूदा कनेक्शन की जगह लेगा। यदि यह Telegram किसी अन्य प्लेटफ़ॉर्म खाते से जुड़ा है, तो वह कनेक्शन भी हट जाएगा।", "लिंक 10 मिनट में समाप्त हो जाएगा।", "कनेक्ट करने के लिए Telegram खोलें", "हो गया, स्थिति जाँचें", "डिस्कनेक्ट करने पर इस खाते को Telegram सूचनाएँ नहीं मिलेंगी। बाद में फिर कनेक्ट कर सकते हैं।", "डिस्कनेक्ट की पुष्टि करें", "रद्द करें", "Telegram सूचना प्रकार", "हर सूचना को अलग से नियंत्रित करें। बदलाव तुरंत सहेजे जाते हैं।", "बाज़ार मूल्य और नई परियोजनाएँ", "कमीशन अपडेट", "आंशिक ऑर्डर निष्पादन", "ऑर्डर पूरा हुआ", "Telegram कनेक्ट हो गया।", "कनेक्शन पूरा नहीं हुआ। Telegram में Start दबाकर फिर जाँचें।", "स्थिति रीफ़्रेश नहीं हुई।", "Telegram डिस्कनेक्ट हो गया।", "अनुरोध पूरा नहीं हुआ। कृपया फिर प्रयास करें।"],
};

type PreferenceKey =
  | "market_alerts_enabled"
  | "commission_updates_enabled"
  | "order_partial_fills_enabled"
  | "order_completed_enabled";

type TelegramAccount = {
  linked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
  botUsername: string | null;
  preferences: Record<PreferenceKey, boolean>;
};

type TelegramLinkResponse = { linkUrl: string; expiresAt: string };

const preferenceOptions: { key: PreferenceKey; copyKey: TelegramCopyKey }[] = [
  { key: "market_alerts_enabled", copyKey: "marketAlerts" },
  { key: "commission_updates_enabled", copyKey: "commissionUpdates" },
  { key: "order_partial_fills_enabled", copyKey: "partialFills" },
  { key: "order_completed_enabled", copyKey: "orderCompleted" },
];

async function telegramRequest<T>(body?: Record<string, unknown>): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error("登入狀態已失效，請重新登入。");
  const response = await fetch("/api/telegram-account", {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "Telegram 設定暫時無法處理，請稍後再試。");
  return result;
}

export function TelegramAccountSettings({ userId, language }: { userId: string; language: string }) {
  const locale = telegramCopy[language as Lang] ?? telegramCopy.en;
  const text = (key: TelegramCopyKey) => locale[telegramCopyKeys.indexOf(key)];
  const { data, error, isLoading, mutate } = useSWR<TelegramAccount>(
    userId ? `telegram-account:${userId}` : null,
    () => telegramRequest<TelegramAccount>(),
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [linkExpiresAt, setLinkExpiresAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingPreference, setSavingPreference] = useState<PreferenceKey | null>(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  const createLink = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await telegramRequest<TelegramLinkResponse>({ action: "create_link" });
      setLinkUrl(result.linkUrl);
      setLinkExpiresAt(result.expiresAt);
      setConfirmUnlink(false);
    } catch {
      setNotice({ text: text("requestError"), error: true });
    } finally {
      setBusy(false);
    }
  };

  const refreshLink = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const latest = await mutate();
      if (latest?.linked) {
        setLinkUrl(null);
        setLinkExpiresAt(null);
        setConfirmUnlink(false);
        setNotice({ text: text("connectedSuccess") });
      } else {
        setNotice({ text: text("pending"), error: true });
      }
    } catch {
      setNotice({ text: text("refreshError"), error: true });
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await telegramRequest({ action: "unlink" });
      await mutate();
      setLinkUrl(null);
      setLinkExpiresAt(null);
      setConfirmUnlink(false);
      setNotice({ text: text("disconnectedSuccess") });
    } catch (requestError) {
      setNotice({ text: requestError instanceof Error ? requestError.message : "Telegram 解除連結失敗。", error: true });
    } finally {
      setBusy(false);
    }
  };

  const togglePreference = async (key: PreferenceKey) => {
    if (!data?.linked || savingPreference) return;
    setSavingPreference(key);
    setNotice(null);
    try {
      await telegramRequest({ action: "preferences", preferences: { [key]: !data.preferences[key] } });
      await mutate();
    } catch {
      setNotice({ text: text("requestError"), error: true });
    } finally {
      setSavingPreference(null);
    }
  };

  return (
    <div className="border-b border-slate-800 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span className="rounded-xl bg-sky-500/10 p-2.5 text-sky-300" aria-hidden="true">
            <Send className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{text("title")}</h3>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${data?.linked ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                {isLoading ? text("loading") : error ? text("unavailable") : data?.linked ? text("connected") : text("notConnected")}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              {data?.linked
                ? data.telegramUsername ? `@${data.telegramUsername}` : text("connectedAccount")
                : text("connectHelp")}
            </p>
            {data?.linkedAt && <p className="mt-1 text-xs text-slate-500">{text("connectedAt")}{new Date(data.linkedAt).toLocaleString(language)}</p>}
            {error && <p role="alert" className="mt-2 text-xs text-rose-300">{text("readError")}</p>}
            {!isLoading && !error && !data?.botUsername && <p role="status" className="mt-2 text-xs text-amber-300">{text("botMissing")}</p>}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <button
            type="button"
            onClick={() => void createLink()}
            disabled={busy || isLoading || Boolean(error) || !data?.botUsername}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-2.5 text-sm font-semibold text-sky-200 transition hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            <Link2 className="size-4" />
            {busy ? text("working") : data?.linked ? text("change") : text("connect")}
          </button>
          {data?.linked && !confirmUnlink && (
            <button
              type="button"
              onClick={() => setConfirmUnlink(true)}
              disabled={busy}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 transition hover:bg-slate-800 disabled:opacity-50"
            >
              <Unlink className="size-4" />
              {text("disconnect")}
            </button>
          )}
        </div>
      </div>

      {linkUrl && (
        <div className="mt-4 rounded-xl border border-sky-400/20 bg-sky-500/5 p-4">
          <p className="text-sm font-medium text-slate-200">
            {text("linkInstructions")}
          </p>
          <p className="mt-1 text-xs leading-5 text-slate-400">
            {text("linkReplace")} {text("linkExpiry")}
            {linkExpiresAt ? ` ${text("connectedAt")}${new Date(linkExpiresAt).toLocaleTimeString(language)}` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-sky-400 px-4 py-2 text-sm font-bold text-slate-950 transition hover:bg-sky-300"
            >
              <Send className="size-4" />
              {text("openTelegram")}
            </a>
            <button
              type="button"
              onClick={() => void refreshLink()}
              disabled={busy}
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className="size-4" />
              {text("checkStatus")}
            </button>
          </div>
        </div>
      )}

      {confirmUnlink && (
        <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
          <p className="text-sm text-amber-100">{text("unlinkWarning")}</p>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={() => void unlink()} disabled={busy} className="rounded-lg bg-rose-500/15 px-4 py-2 text-sm font-semibold text-rose-200 hover:bg-rose-500/25 disabled:opacity-50">{text("confirmUnlink")}</button>
            <button type="button" onClick={() => setConfirmUnlink(false)} disabled={busy} className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50">{text("cancel")}</button>
          </div>
        </div>
      )}

      {data?.linked && (
        <div className="mt-5 border-t border-slate-800 pt-4">
          <p className="text-sm font-medium">{text("typesTitle")}</p>
          <p className="mt-1 text-xs text-slate-500">{text("typesHint")}</p>
          <div className="mt-2 divide-y divide-slate-800/80">
            {preferenceOptions.map(({ key, copyKey }) => (
              <div key={key} className="flex items-center justify-between gap-4 py-3">
                <span className="text-sm text-slate-300">{text(copyKey)}</span>
                <button
                  type="button"
                  role="switch"
                  aria-label={text(copyKey)}
                  aria-checked={data.preferences[key]}
                  disabled={savingPreference !== null}
                  onClick={() => void togglePreference(key)}
                  className={`relative h-6 w-11 shrink-0 rounded-full transition ${data.preferences[key] ? "bg-sky-400" : "bg-slate-700"} disabled:cursor-wait disabled:opacity-60`}
                >
                  <span className={`absolute top-1 size-4 rounded-full bg-white transition ${data.preferences[key] ? "left-6" : "left-1"}`} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {notice && <p role="status" className={`mt-3 rounded-lg border px-3 py-2 text-sm ${notice.error ? "border-rose-500/20 bg-rose-500/5 text-rose-200" : "border-emerald-500/20 bg-emerald-500/5 text-emerald-200"}`}>{notice.text}</p>}
    </div>
  );
}

export default TelegramAccountSettings;
