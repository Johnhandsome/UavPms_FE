# 🚀 GITHUB ISSUES: TÍCH HỢP SIGNALR REAL-TIME ĐA VAI TRÒ (MF01, MF02, MF03)

Tài liệu này bao gồm nội dung chuẩn bị sẵn theo định dạng GitHub Issue Markdown. Bạn có thể sao chép trực tiếp nội dung từng Issue dưới đây để tạo Issue trên GitHub repository.

---

# ISSUE 1: [MF02] Tích hợp SignalR Real-time cho Vòng đời Điều phối & Tiếp nhận Nhiệm vụ Bay (Manager ⟷ Inspector)

**Tiêu đề Issue (Title)**:  
`[Feature/Realtime] Tích hợp SignalR Real-time cho Vòng đời Điều phối & Tiếp nhận Nhiệm vụ Bay (MF02)`

**Nhãn (Labels)**: `enhancement`, `realtime`, `signalr`, `MF02`, `high-priority`

### Mô tả bài toán (Problem Description)
Hiện tại, toàn bộ luồng tương tác giữa **Quản lý vận hành (Manager)** và **Thanh tra viên / Phi công UAV (Inspector)** trong module MF02 đang chạy ở trạng thái tĩnh hoặc chỉ cập nhật local signal. 
- Khi Inspector bấm *"Xác nhận tiếp nhận nhiệm vụ"* trên `/missions/:id/inspector`, màn hình Manager trên `/missions/:id` vẫn giữ nguyên trạng thái `PENDING_CONFIRMATION` (Chờ xác nhận) và không hề biết phi công đã nhận lệnh trừ khi tải lại trang (F5).
- Khi Manager gửi chỉ đạo điều phối hoặc ra lệnh khẩn cấp dừng bay (*Tạm đình chỉ*, *Hoãn*, *Hủy*, *Khôi phục*), phi công ngoài hiện trường không nhận được thông báo thời gian thực, tiềm ẩn nguy cơ mất an toàn bay nghiêm trọng.
- Tin nhắn trao đổi 2 chiều (`communicationLogs`) chỉ lưu trên máy người gửi, không nhảy sang máy người nhận.

### Các điểm cần chỉnh sửa & triển khai (Requirements)
- [ ] **1. Xác nhận tiếp nhận nhiệm vụ thời gian thực (`MissionConfirmed`)**:
  - Khi Inspector bấm xác nhận tại `/missions/:id/inspector`, phát SignalR event `MissionConfirmed`.
  - Phía Manager (`mission-detail.ts`): Lắng nghe sự kiện, tự động đổi badge sang `CONFIRMED` (màu xanh), tắt khung cảnh báo chờ xác nhận, cập nhật mốc Milestone hành trình mà không cần F5.
  - Phía danh sách (`mission-list.ts`): Cập nhật badge trong bảng danh sách và giảm số lượng thẻ thống kê đang chờ xử lý.
- [ ] **2. Ban hành nhiệm vụ mới (`MissionDispatched`)**:
  - Khi Manager tạo và ban hành nhiệm vụ từ `/missions/new` hoặc console, phát sự kiện `MissionDispatched`.
  - Phía Inspector (`mission-list.ts` / `/missions/my`): Nhiệm vụ mới tự động nhảy lên đầu bảng danh sách của phi công kèm toast thông báo nhận nhiệm vụ mới.
- [ ] **3. Kênh trao đổi / Tin nhắn điều phối 2 chiều (`MissionCommunicationReceived`)**:
  - Khi Manager gửi lời dặn (`managerInstructions`) hoặc gửi tin nhắn trong khung trao đổi: Tin nhắn tự động hiển thị trên giao diện của Inspector tức thì.
  - Khi Inspector gửi phản hồi hiện trường: Tin nhắn tự động nổi lên trong khung chat của Manager.
- [ ] **4. Lệnh khẩn cấp dừng bay: Đình chỉ / Hoãn / Khôi phục / Hủy (`MissionSuspended`, `MissionPostponed`, `MissionResumed`, `MissionCancelled`)**:
  - Khi Manager bấm *"Tạm đình chỉ bay"* hoặc *"Hoãn bay"*: Màn hình Inspector lập tức hiển thị Banner cảnh báo đỏ dừng bay khẩn cấp và khóa nút tiếp tục bay.
  - Khi Manager bấm *"Khôi phục bay"*: Màn hình Inspector tự động chuyển lại sang trạng thái sẵn sàng.
- [ ] **5. Nhắc nhở khẩn cấp từ Quản lý (`MissionReminderSent`)**:
  - Khi Manager bấm *"Gửi nhắc nhở khẩn cấp"*: Inspector nhận được popup/toast cảnh báo có âm thanh kèm hạn chót xác nhận.
- [ ] **6. Hết hạn xác nhận tự động (`MissionConfirmationOverdue`)**:
  - Khi đồng hồ `confirmationDeadline` kết thúc: Tự động đổi trạng thái hiển thị alert đỏ quá hạn trên cả 2 màn hình.

### Files tác động dự kiến
- `src/app/features/notifications/data-access/notifications-realtime.ts` (Mở rộng SignalR hub listener & emitter)
- `src/app/features/missions/pages/mission-detail/mission-detail.ts` & `mission-detail.html`
- `src/app/features/missions/pages/mission-inspector/mission-inspector.ts` & `mission-inspector.html`
- `src/app/features/missions/pages/mission-list/mission-list.ts`

---

# ISSUE 2: [MF03] Đồng bộ Real-time cho Thực thi Bay, AI Workbench, Duyệt Khuyết Tật & Bảo Trì

**Tiêu đề Issue (Title)**:  
`[Feature/Realtime] Đồng bộ Real-time cho AI Workbench, Duyệt Khuyết Tật & Phiếu Bảo Trì (MF03)`

**Nhãn (Labels)**: `enhancement`, `realtime`, `signalr`, `AI`, `MF03`, `high-priority`

### Mô tả bài toán (Problem Description)
Trong MF03 (Thực thi bay, Phân tích AI và Quản lý bảo trì lưới điện), sự phối hợp giữa **Inspector (tải tệp bay)**, **Hệ thống AI (phân tích ảnh/video)**, **Manager / Analyst (duyệt khuyết tật)** và **Technician (sửa chữa bảo trì)** đang bị đứt gãy tính thời gian thực:
- Có bug logic tại dòng 1437 của `mission-detail.ts`: Kiểm tra `matchesCurrentUpload` dựa vào `mediaQueue`. Do Manager không phải là người chọn tệp trên máy tính (queue rỗng) nên sự kiện `AiAnalysisStatusChanged` bị chặn `return`, **Manager hoàn toàn không thấy tiến trình AI và không tự động tải danh sách khuyết tật mới**.
- Khi AI phát hiện ra khuyết tật mới (vỡ bát sứ, rỉ sét, đứt tao dây dẫn), tab "Kết quả AI" không tự đẩy thẻ mới vào danh sách.
- Khi Analyst/Manager bấm duyệt (`CONFIRMED` / `REJECTED`), trạng thái không nhảy sang các màn hình khác.
- Khi tạo phiếu giao việc bảo trì cho Technician, Technician không nhận được phiếu realtime.

### Các điểm cần chỉnh sửa & triển khai (Requirements)
- [ ] **1. Sửa lỗi chặn tiến trình AI phía Quản lý (`handleAiAnalysisStatus`)**:
  - Cho phép Manager lắng nghe sự kiện `AiAnalysisStatusChanged` theo `event.missionId === currentMissionId` mà không phụ thuộc vào `mediaQueue` cục bộ.
  - Khi trạng thái AI chuyển sang `Completed`: Tự động kích hoạt gọi `loadDetections(missionId)` để nạp khuyết tật mới tức thì mà không cần F5.
- [ ] **2. Đồng bộ hàng đợi Media tải lên từ hiện trường (`MissionMediaUploaded`)**:
  - Khi Inspector ở hiện trường tải ảnh/video lên, Manager tại trung tâm điều hành thấy danh sách tệp xuất hiện theo thời gian thực.
- [ ] **3. Đẩy khuyết tật AI mới vào danh sách thời gian thực (`AiDetectionsCreated`)**:
  - Khi AI hoàn thành phân tích theo lô (batch), phát sự kiện danh sách khuyết tật mới.
  - Cập nhật tự động mảng `detections()` và badge số lượng khuyết tật trên tab navigation mà không cần chuyển tab.
- [ ] **4. Duyệt / Bác bỏ khuyết tật thời gian thực (`DetectionReviewed`)**:
  - Khi Analyst/Manager bấm *"Xác nhận khuyết tật"* hoặc *"Bác bỏ"*, phát sự kiện `DetectionReviewed`.
  - Cập nhật tức thì nhãn duyệt trên tất cả màn hình đang xem và cập nhật lại điểm sức khỏe thiết bị (`healthScore`).
- [ ] **5. Tạo & Cập nhật phiếu bảo trì thời gian thực (`MaintenanceTaskCreated`, `MaintenanceTaskStatusChanged`)**:
  - Khi Manager tạo phiếu bảo trì từ khuyết tật AI: Tab "Bảo trì" của Technician tự động nhận phiếu công việc mới.
  - Khi Technician cập nhật tiến độ hoặc hoàn thành: Quản lý thấy trạng thái chuyển sang `Completed` ngay lập tức.
- [ ] **6. Cảnh báo sự cố khẩn cấp (Emergency Siren / Live Banner)**:
  - Khi UAV hoặc AI phát hiện cháy rừng/đổ cột (`EMERGENCY_ALERT`): Tích hợp còi hú cảnh báo và Banner đỏ nhấp nháy ngay trên trang điều phối chuyến bay `mission-detail`.

### Files tác động dự kiến
- `src/app/features/missions/pages/mission-detail/mission-detail.ts` & `mission-detail.html`
- `src/app/features/assets/data-access/asset-management-api.ts`
- `src/app/features/notifications/data-access/notifications-realtime.ts`
- `src/app/features/emergency-alerts/pages/emergency-alerts-review/emergency-alerts-review.ts`

---

# ISSUE 3: [MF01] Cập nhật Trạng thái Thẩm định Sẵn sàng Tiền bay theo Thời gian thực (Pre-Mission Readiness)

**Tiêu đề Issue (Title)**:  
`[Feature/Realtime] Cập nhật Trạng thái Thẩm định Sẵn sàng Tiền bay theo Thời gian thực (MF01)`

**Nhãn (Labels)**: `enhancement`, `realtime`, `signalr`, `MF01`, `medium-priority`

### Mô tả bài toán (Problem Description)
Trong MF01, nhiều vai trò cùng tham gia thẩm định 4 trụ cột an toàn bay (Mặt bằng & Khí tượng, Nhân sự, UAV, Kỹ thuật vi điều khiển):
- Kỹ thuật viên (Technician) thực hiện chẩn đoán sức khỏe phần cứng UAV (Flight Controller, pin, cảm biến, RTK) ở Tab 5, nhưng Quản lý (Manager) ở Tab 1 (Tổng quan) không nhận được kết quả realtime, khiến nút *"Tạo nhiệm vụ (MF02)"* không tự mở khóa.
- Khi Manager kích hoạt đánh giá lại (`evaluate()`), danh sách `assessment-list` không đổi màu trạng thái.
- Đánh giá đã được tạo nhiệm vụ (`COMPLETED`) hoặc hết hạn (`validUntil`) không được đồng bộ tức thời giữa các tài khoản.

### Các điểm cần chỉnh sửa & triển khai (Requirements)
- [ ] **1. Đồng bộ trạng thái thẩm định thời gian thực (`AssessmentStatusChanged`)**:
  - Khi kích hoạt đánh giá lại, phát sự kiện cập nhật trạng thái `READY` / `NOT_READY` / `EVALUATING` tới toàn bộ client đang mở `assessment-workspace` và `assessment-list`.
- [ ] **2. Kết quả kiểm tra kỹ thuật UAV thời gian thực (`DroneInspectionCompleted`)**:
  - Khi Drone Technician chạy kiểm tra kỹ thuật thiết bị bay ở Tab 5: Cột mốc Technical tự động cập nhật sang `PASS` trên màn hình của Manager, đồng thời mở khóa nút *"Tạo nhiệm vụ (MF02)"* ngay lập tức.
- [ ] **3. Cập nhật trạng thái hoàn thành / tạo nhiệm vụ (`AssessmentCompleted`)**:
  - Khi một bản ghi được tạo thành công nhiệm vụ bay MF02: Tự động cập nhật huy hiệu `#msn-xxxx` và chuyển trạng thái `COMPLETED` trên danh sách của các người dùng khác.
- [ ] **4. Cảnh báo sức gió bề mặt thời gian thực (`MeteoAlertTriggered`)**:
  - Đẩy cảnh báo thời tiết vượt ngưỡng an toàn (sức gió > 10 m/s) làm đổi màu trụ cột Mặt bằng sang đỏ (`FAIL`) thời gian thực.

### Files tác động dự kiến
- `src/app/features/pre-mission/pages/assessment-workspace/assessment-workspace.ts` & `assessment-workspace.html`
- `src/app/features/pre-mission/pages/assessment-list/assessment-list.ts` & `assessment-list.html`
- `src/app/features/pre-mission/data-access/pre-mission-api.ts`
- `src/app/features/notifications/data-access/notifications-realtime.ts`
