# 📋 TÀI LIỆU CÂU HỎI KỸ THUẬT & ĐẶC TẢ ĐA VAI TRÒ GỬI ĐỘI NGŨ BACKEND
## V/v: Nâng cấp Quy trình Nhân sự Đa Vai trò (Inspector, Analyst, Technician) cho MF01 & MF02

> **Người gửi**: Đội ngũ Frontend (Angular 20 Standalone)  
> **Người nhận**: Đội ngũ Backend (ASP.NET Core / EF Core / SignalR)  
> **Tài liệu tham chiếu**: 
> - [MF01 v2.0 Specification](file:///e:/UavPms_FE/docs/mainflows/MF01_v2.0_FE_PreMission_Readiness.md)
> - [MF02 v2.0 Specification](file:///e:/UavPms_FE/docs/mainflows/MF02_v2.0_FE_Create_Assign_Mission.md)
> - [Backend SignalR Issue MF02](file:///e:/UavPms_FE/docs/BACKEND_ISSUE_REALTIME_SIGNALR_MF02.md)
> 
> **Mức độ ưu tiên**: 🔴 **Cao (High - Blocker hoàn thiện luồng nghiệp vụ & đồng bộ Realtime)**

---

## 1. Tóm tắt Thay đổi Nghiệp vụ (Executive Summary)

Theo yêu cầu nghiệp vụ mới nhất của hệ thống UAV-PMS phục vụ kiểm tra lưới điện EVN:

1. **Tại MF01 (Đánh giá tính khả thi & Sẵn sàng nguồn lực - Pre-Mission Assessment)**:
   - Đánh giá nhân sự không còn kiểm tra phi công đơn lẻ. Hệ thống bắt buộc phải kiểm tra và đảm bảo tính khả dụng của **ít nhất 3 vai trò chuyên trách**:
     - **Inspector / Pilot** (Thanh tra viên / Phi công UAV điều khiển bay hiện trường)
     - **Analyst** (Chuyên viên phân tích ảnh/video khuyết tật kỹ thuật & mô hình AI)
     - **Technician** (Kỹ thuật viên phần cứng drone, trạm sạc, pin, tải trọng payload)
   - Điều kiện đạt chuẩn `PASS` / `READY` của nhóm Personnel: Mỗi vai trò phải có **ít nhất 01 nhân sự hợp lệ** (tổng tối thiểu 3 người cho 3 role).
   - Bộ tiêu chuẩn lọc ứng viên gồm **5 điều kiện đồng thời (Logic AND)**:
     $$\text{Eligible} \land \text{Active} \land \text{Within Region/Scope} \land \text{Available during proposed time} \land \text{Has required role/qualification}$$
   - Manager có thể cấu hình số lượng nhân sự mong muốn cho từng vai trò tùy theo quy mô tuyến đường dây.

2. **Tại MF02 (Tạo & Phân công nhiệm vụ - Create & Assign Mission)**:
   - Khi tạo nhiệm vụ từ Assessment READY, Manager bắt buộc phải phân công đủ **tối thiểu 3 vai trò** (Inspector $\ge 1$, Analyst $\ge 1$, Technician $\ge 1$).
   - Vòng đời xác nhận (Confirmation Lifecycle): Hệ thống **không chỉ làm việc với Inspector** nữa, mà phải gửi thông báo, SignalR và **chờ phản hồi xác nhận đầy đủ từ cả 3 vai trò**.
   - Nhiệm vụ chỉ chuyển sang trạng thái `CONFIRMED` (Sẵn sàng bay thực địa MF03) khi **100% các thành viên được gán đã bấm Chấp nhận (Accept)**.
   - Nếu có bất kỳ ai xin hoãn (Postpone), hệ thống phải thông báo ngay lập tức cho Manager và hỗ trợ cơ chế đổi người (Reassign) cho vai trò đó mà không cần phải hủy và tạo lại nhiệm vụ từ đầu.

---

## 2. Danh sách Câu hỏi Kỹ thuật & Nghiệp vụ cần Backend xác nhận

### 📌 Nhóm 1: Cơ sở dữ liệu & Model Quan hệ (Database Schema & EF Core)

- **Câu hỏi 1.1**: Cấu trúc bảng phân công nhiệm vụ (`MissionAssignments`):
  - Hiện tại bảng `Missions` có các cột đơn lẻ như `assigned_to_user_id`, `inspector_id`. Backend dự kiến lưu trữ danh sách thành viên thực hiện nhiệm vụ như thế nào?
  - *Phương án FE khuyến nghị*: Tạo bảng quan hệ `MissionAssignments`:
    ```sql
    CREATE TABLE mission_assignments (
        id VARCHAR(36) PRIMARY KEY,
        mission_id VARCHAR(36) NOT NULL,
        user_id VARCHAR(36) NOT NULL,
        role VARCHAR(20) NOT NULL, -- 'INSPECTOR', 'ANALYST', 'TECHNICIAN'
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- 'PENDING', 'ACCEPTED', 'POSTPONED', 'REPLACED'
        confirmed_at TIMESTAMP NULL,
        postponed_at TIMESTAMP NULL,
        postpone_reason TEXT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL,
        CONSTRAINT fk_mission FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
        CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id)
    );
    ```
    Backend đã có bảng này chưa hay đang dự kiến thiết kế theo hướng khác?

- **Câu hỏi 1.2**: Định dạng Role trong Database và API:
  - Giá trị Role trả về cho Frontend là chuỗi ký tự hoa: `'INSPECTOR'`, `'ANALYST'`, `'TECHNICIAN'` hay dạng số nguyên (Enum: `0, 1, 2`)?
  - *Yêu cầu FE*: Mong muốn Backend thống nhất trả về dạng chuỗi chuẩn: `"INSPECTOR" | "ANALYST" | "TECHNICIAN"` để tránh sai lệch mapping Enum.

---

### 📌 Nhóm 2: API Phân công & Tạo Nhiệm vụ (MF02 Create Mission API)

- **Câu hỏi 2.1**: Payload của API tạo nhiệm vụ `POST /api/v2/missions`:
  - Để hỗ trợ chọn số lượng và nhiều thành viên cho cả 3 roles, Backend mong muốn nhận dữ liệu phân công theo định dạng nào trong request body?
  - *Phương án A (Mảng assignments đồng nhất - Khuyến nghị)*:
    ```json
    {
      "assessmentId": "asm-12345",
      "name": "Kiểm tra định kỳ ĐZ 220kV Sông Mây - Long Thành",
      "plannedStart": "2026-09-26T07:00:00Z",
      "plannedEnd": "2026-09-26T17:00:00Z",
      "confirmationDeadline": "2026-09-25T20:00:00Z",
      "droneId": "drone-matrice-350-01",
      "priority": "High",
      "assignments": [
        { "userId": "usr-inspector-01", "role": "INSPECTOR" },
        { "userId": "usr-analyst-02", "role": "ANALYST" },
        { "userId": "usr-technician-03", "role": "TECHNICIAN" }
      ],
      "targetAssetIds": ["t-01", "t-02", "t-03"],
      "managerInstructions": "Chú ý khoảng cách an toàn với pha giữa khoảng cột 12-14."
    }
    ```
  - *Phương án B (Phân tách theo field riêng)*:
    ```json
    {
      "inspectorIds": ["usr-inspector-01"],
      "analystIds": ["usr-analyst-02"],
      "technicianIds": ["usr-technician-03"]
    }
    ```
    Backend ưu tiên phương án nào để Frontend hoàn thiện Form và Interface?

- **Câu hỏi 2.2**: Ràng buộc tạo nhiệm vụ phía Backend:
  - Nếu Manager vô tình hoặc cố ý chỉ gửi 1 hoặc 2 vai trò (ví dụ: thiếu Analyst), Backend sẽ trả về mã lỗi HTTP nào?
  - *FE đề xuất*: Trả về `400 Bad Request` hoặc `422 Unprocessable Entity` kèm mã lỗi rõ ràng:
    ```json
    {
      "errorCode": "INSUFFICIENT_ROLES_ASSIGNED",
      "message": "Nhiệm vụ bắt buộc phải phân công đủ ít nhất 3 vai trò: Inspector, Analyst và Technician.",
      "missingRoles": ["ANALYST"]
    }
    ```

---

### 📌 Nhóm 3: Vòng đời Xác nhận & Trạng thái Tổng hợp (Confirmation Workflow & Lifecycle)

- **Câu hỏi 3.1**: Endpoints tiếp nhận phản hồi từ thành viên:
  - Khi một thành viên (Inspector, Analyst hoặc Technician) bấm Chấp nhận hoặc Xin hoãn, Backend thiết kế endpoint theo cách nào?
    - **Cách 1 (Theo Assignment ID - Khuyến nghị)**:
      - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/accept`
      - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/postpone`
        - Payload: `{ "reason": "Bị sự cố pin trạm mặt đất chưa khắc phục xong." }`
    - **Cách 2 (Context tự động qua JWT Token)**:
      - `POST /api/v2/missions/{missionId}/accept`
      - `POST /api/v2/missions/{missionId}/postpone`
        - Backend tự đối chiếu `UserId` trong JWT với bảng `MissionAssignments` của `missionId`.
    Backend đang triển khai hoặc mong muốn FE gọi theo Cách 1 hay Cách 2?

- **Câu hỏi 3.2**: Quy tắc chuyển trạng thái tổng thể của Mission (`Mission.Status`):
  - Khi tạo xong, trạng thái là `PENDING_CONFIRMATION`.
  - **Trường hợp 1**: Khi Inspector bấm Accept, nhưng Analyst và Technician chưa phản hồi:
    - Trạng thái Mission vẫn giữ nguyên `PENDING_CONFIRMATION` hay chuyển thành `CONFIRMING_PARTIAL`?
    - Frontend cần hiển thị tiến độ xác nhận (ví dụ: "1/3 đã xác nhận"). Backend có trường `confirmedCount` và `totalRequiredCount` trong Mission DTO không?
  - **Trường hợp 2**: Khi 1 trong 3 người bấm Postpone:
    - Trạng thái Mission chuyển thành gì? `POSTPONED` hay `REASSIGNMENT_REQUIRED`?
    - Những người đã bấm Accept trước đó có bị hủy xác nhận không? (Khuyến nghị: Không hủy, chỉ chờ Manager gán người mới cho vị trí bị hoãn).
  - **Trường hợp 3**: Khi cả 3 người đều đã Accept:
    - Mission tự động chuyển thành `CONFIRMED`. Backend có phát sinh thông báo thành công cho Manager không?

- **Câu hỏi 3.3**: Cơ chế Thay đổi / Đổi nhân sự (Reassign Role) khi có người xin hoãn:
  - Khi một vai trò (ví dụ: Technician A) xin hoãn, Manager cần gán Technician B vào thay thế. Backend đã có API phục vụ việc này chưa?
  - *Đề xuất API*:
    - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/reassign`
      - Payload:
        ```json
        {
          "newUserId": "usr-technician-04",
          "reassignReason": "Thay thế do KTV A xin dời lịch"
        }
        ```
    - Nghiệp vụ mong muốn:
      - Bản ghi cũ của Technician A đổi sang `REPLACED` hoặc lưu vào lịch sử.
      - Tạo bản ghi mới cho Technician B với trạng thái `PENDING`.
      - Gửi thông báo và SignalR event cho Technician B để người này tiếp nhận xác nhận.

- **Câu hỏi 3.4**: Xử lý Quá hạn Xác nhận (`confirmationDeadline` & Overdue Job):
  - Khi đồng hồ hệ thống vượt quá `confirmationDeadline` mà vẫn còn thành viên ở trạng thái `PENDING`:
    - Backend có Background Service tự động đổi trạng thái Mission thành `OVERDUE` không?
    - Hay hệ thống chỉ bắn thông báo nhắc nhở cảnh báo mà vẫn cho phép các thành viên tiếp tục Accept nếu Manager chưa hủy nhiệm vụ?

---

### 📌 Nhóm 4: Đánh giá Tính khả dụng Nhân sự tại MF01 (Personnel Readiness Evaluation)

- **Câu hỏi 4.1**: API trả về danh sách ứng viên tiềm năng `GET /api/v2/pre-mission-assessments/{id}/personnel-candidates`:
  - Để thỏa mãn 5 điều kiện (Logic AND):
    1. `Eligible`
    2. `Active`
    3. `Within Region/Scope`
    4. `Available during proposed time`
    5. `Has required role/qualification`
  - Backend đã tích hợp bộ lọc này vào query chưa?
  - Dữ liệu trả về cho mỗi ứng viên có bao gồm chi tiết lý do nếu ứng viên bị cảnh báo/không khả dụng không?
  - *Mẫu DTO ứng viên đề xuất*:
    ```json
    {
      "id": "usr-01",
      "name": "Nguyễn Văn A",
      "role": "INSPECTOR", // "INSPECTOR" | "ANALYST" | "TECHNICIAN"
      "regionId": "reg-dong-nai",
      "regionName": "PC Đồng Nai",
      "isActive": true,
      "isEligible": true,
      "isWithinScope": true,
      "isAvailable": true,
      "overallEligibility": "ELIGIBLE", // "ELIGIBLE" | "INELIGIBLE"
      "qualificationDetails": "Chứng chỉ điều khiển UAV cấp 2, An toàn điện bậc 4/5",
      "scheduleConflict": null,
      "reason": "Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành"
    }
    ```

- **Câu hỏi 4.2**: Cấu hình số lượng nhân sự yêu cầu (Required Headcount per Role):
  - Khi tạo Assessment, Manager có thể cần: 2 Inspector, 1 Analyst, 1 Technician.
  - Backend có lưu trữ cấu hình số lượng tối thiểu này trong `PreMissionAssessment` không?
  - Trạng thái `assessment.personnel.status` được Backend tính toán là `PASS` chỉ khi đáp ứng đủ số lượng này của cả 3 role đúng không?

---

### 📌 Nhóm 5: SignalR Hub & Real-time Events Đa Vai trò

- **Câu hỏi 5.1**: Cơ chế gia nhập phòng (Group Management) khi Dispatch nhiệm vụ:
  - Khi Manager bấm Create Mission, Backend phát event `MissionDispatched`.
  - Backend gửi event này tới từng UserId qua `Clients.Users(assignedUserIds)` hay qua cơ chế nào khác để đảm bảo cả 3 người (Inspector, Analyst, Technician) đều nhận được chuông thông báo ngay trên thanh điều hướng?

- **Câu hỏi 5.2**: Dữ liệu gửi kèm trong SignalR Event `MissionConfirmed` & `MissionPostponed`:
  - Để Frontend cập nhật ngay ma trận trạng thái trên màn hình Manager mà không cần gọi thêm API `GET /api/missions/{id}`, Backend có gửi kèm các thông tin sau trong payload realtime không:
    - `assignmentId`: ID phân công vừa được cập nhật.
    - `actorRole`: Vai trò của người vừa phản hồi (`INSPECTOR` / `ANALYST` / `TECHNICIAN`).
    - `actorName`: Tên người phản hồi.
    - `allConfirmed`: `true` nếu toàn bộ các vai trò đã chấp nhận, ngược lại `false`.
    - `pendingRoles`: Mảng các vai trò còn lại đang chờ (ví dụ: `["ANALYST"]`).

---

### 📌 Nhóm 6: Giao diện Tiếp nhận Nhiệm vụ Phía Nhân sự (Front-facing Consoles)

- **Câu hỏi 6.1**: Hướng tiếp cận Route cho 3 vai trò tiếp nhận nhiệm vụ:
  - Hiện tại Frontend có route dành riêng cho Inspector: `/missions/:id/inspector`.
  - Với việc Analyst và Technician cũng cần xem thông tin và Accept/Postpone:
    - **Phương án 1 (Hợp nhất - FE Khuyến nghị)**: Dùng chung một route duy nhất `/missions/:id/confirmation`. Giao diện tự động nhận diện vai trò của người đang đăng nhập để hiển thị tab nghiệp vụ tương ứng:
      - *Nếu là Inspector*: Hiển thị bản đồ GIS, hành lang bay, thông số UAV, thời tiết.
      - *Nếu là Analyst*: Hiển thị danh sách thiết bị trên cột, cấu hình ảnh/video cần phân tích, mô hình AI áp dụng.
      - *Nếu là Technician*: Hiển thị checklist kỹ thuật phần cứng UAV, số chu kỳ pin, tình trạng trạm mặt đất.
    - **Phương án 2 (Tách biệt)**: Chia thành 3 route riêng biệt: `/missions/:id/inspector`, `/missions/:id/analyst`, `/missions/:id/technician`.
    Backend có khuyến nghị hoặc ràng buộc gì về phân quyền (RBAC Policy) giữa các endpoint này không?

---

## 3. Bảng Ma trận Yêu cầu Đã Thống nhất (Decision Matrix)

> *Ghi chú: Đội ngũ Backend đã chính thức phản hồi và phê duyệt toàn bộ 10 hạng mục tại [Văn bản phản hồi kỹ thuật](file:///e:/UavPms_FE/docs/BACKEND_RESPONSE_MULTI_ROLE_WORKFLOW_MF01_MF02.md).*

| STT | Vấn đề kỹ thuật | Đề xuất từ Frontend | Trạng thái Backend | Ghi chú & Cam kết Backend |
| :---: | :--- | :--- | :---: | :--- |
| **1** | Bảng lưu trữ phân công đa vai trò | Tạo bảng quan hệ `MissionAssignments` | ✅ **Đã có sẵn** | Entity `MissionAssignment` đã hoạt động trong `OperationsService.Domain`, quan hệ 1-N. |
| **2** | Tên vai trò chuẩn trong API | `"INSPECTOR"`, `"ANALYST"`, `"TECHNICIAN"` (String Enum) | ✅ **Đồng ý 100%** | Chuẩn hóa trả về chuỗi ký tự hoa, không dùng số nguyên Enum. |
| **3** | Payload tạo nhiệm vụ (`POST .../create-mission`) | Sử dụng mảng `assignments: [{ userId, role }]` | ✅ **Đã hỗ trợ** | Backend hỗ trợ cả key `personnel` và `assignments` với `isRequired: true`. |
| **4** | Điều kiện tối thiểu tạo nhiệm vụ | Bắt buộc đủ 3 vai trò, mỗi vai trò $\ge 1$ người | ✅ **Đồng ý** | Trả về `422 Unprocessable Entity` + `INSUFFICIENT_ROLES_ASSIGNED` nếu thiếu vai trò. |
| **5** | Endpoint Accept / Postpone | Hỗ trợ theo ngữ cảnh JWT hoặc AssignmentId | ✅ **Đã có sẵn** | Hỗ trợ `POST .../assignments/accept` và `POST .../assignments/postpone` (qua JWT hoặc ID). |
| **6** | Endpoint Reassign khi hoãn | `POST .../assignments/{id}/reassign` | 🔄 **Đang triển khai** | Sẽ bổ sung endpoint chuyên biệt đổi người và giải phóng booking cũ. |
| **7** | Trạng thái Mission chuyển `CONFIRMED` | Chỉ khi 100% các vai trò bắt buộc đã Accept | ✅ **Đã chuẩn hóa** | Logic `CheckAcceptance()` tự động kích hoạt chuyển sang `Assigned` (CONFIRMED). |
| **8** | Bộ lọc 5 tiêu chí nhân sự MF01 | Backend lọc SQL/Policy theo Logic AND | ✅ **Đồng ý** | Mở rộng `PersonnelEligibilityPolicy` cho cả Analyst & MaintenanceTechnician. |
| **9** | SignalR Payload | Bổ sung `actorRole`, `allConfirmed`, `pendingRoles` | 🔄 **Đang triển khai** | Bổ sung các trường vào `MissionLifecycleEventDto` và broadcast cho mọi user gán. |
| **10**| Màn hình tiếp nhận nhiệm vụ | Thống nhất dùng `/missions/:id/confirmation` | ✅ **Đồng ý 100%** | Backend mở rộng Policy cho `MaintenanceTechnician` truy cập dữ liệu nhiệm vụ. |

---

## 4. Kế hoạch Triển khai Tiếp theo (Next Steps)

1. **Phía Frontend**:
   - Cập nhật Form tạo nhiệm vụ MF02 (`mission-create`) với mảng `assignments: [{ userId, role: 'INSPECTOR' | 'ANALYST' | 'TECHNICIAN', isRequired: true }]`.
   - Xây dựng màn hình `/missions/:id/confirmation` hiển thị thông tin động theo vai trò của người đăng nhập.
   - Thêm thanh tiến độ xác nhận đa vai trò (`confirmedCount` / `totalRequiredCount`) trên `mission-detail`.
   - Kết nối SignalR listener theo định dạng payload mở rộng.
2. **Phía Backend**:
   - Cập nhật DTO `MissionLifecycleEventDto` và broadcast `MissionDispatched` tới tất cả các vai trò.
   - Thêm endpoint `POST /api/v2/missions/{id}/assignments/{assignmentId}/reassign`.
   - Mở rộng `PersonnelEligibilityPolicy` cho cả 3 vai trò tại MF01.
