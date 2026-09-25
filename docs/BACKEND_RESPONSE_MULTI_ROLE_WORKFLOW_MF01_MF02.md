# 📢 PHẢN HỒI KỸ THUẬT TỪ ĐỘI NGŨ BACKEND (ASP.NET Core / EF Core / SignalR)
## V/v: Nâng cấp Quy trình Nhân sự Đa Vai trò (Inspector, Analyst, Technician) cho MF01 & MF02

> **Người gửi**: Đội ngũ Backend (ASP.NET Core / EF Core / SignalR / Hangfire)  
> **Người nhận**: Đội ngũ Frontend (Angular 20 Standalone)  
> **Văn bản phản hồi**: [Tài liệu câu hỏi kỹ thuật & đặc tả đa vai trò MF01 & MF02](file:///e:/UavPms_FE/docs/BACKEND_QUESTIONS_MULTI_ROLE_WORKFLOW_MF01_MF02.md)  
> **Trạng thái**: ✅ **Đã rà soát toàn bộ hiện trạng Codebase & Phê duyệt phương án tích hợp**

---

## 1. Tóm tắt Phê duyệt & Định hướng Chung

Đội ngũ Backend đã rà soát kỹ lưỡng cấu trúc thực tế của hệ thống (`UavPms.OperationsService`, `UavPms.NotificationService`, `UavPms.Shared.Contracts`) và thống nhất 100% với đề xuất nâng cấp của Frontend. Các thỏa thuận chính:

1. **Entity `MissionAssignment`**: Đã có sẵn trong database với quan hệ 1-N với `Missions`.
2. **Chuẩn hóa Role**: Dùng chuỗi ký tự hoa `INSPECTOR`, `ANALYST`, `TECHNICIAN`.
3. **Payload tạo nhiệm vụ**: Hỗ trợ nhận mảng `personnel` hoặc `assignments` với cờ `isRequired`. Bắt buộc đủ 3 vai trò, nếu thiếu trả về HTTP `422 Unprocessable Entity` + `INSUFFICIENT_ROLES_ASSIGNED`.
4. **Vòng đời Xác nhận (Confirmation)**: Hỗ trợ cả 2 endpoint theo ngữ cảnh JWT hoặc `assignmentId`. Chỉ chuyển `CONFIRMED` khi 100% 3 vai trò đã chấp nhận.
5. **Cơ chế Reassign khi hoãn**: Cung cấp endpoint chuyên biệt `POST /api/v2/missions/{id}/assignments/{assignmentId}/reassign`. Người hoãn chuyển sang `Replaced`, người mới vào `Pending`, các thành viên đã Accept trước đó được bảo lưu.
6. **MF01 Candidate Pool**: API `GET .../personnel-candidates` trả về chi tiết 5 tiêu chí lọc AND. Hỗ trợ cấu hình `requiredInspectors`, `requiredAnalysts`, `requiredTechnicians`.
7. **SignalR Realtime**: Bổ sung `actorRole`, `allConfirmed`, `pendingRoles`, `confirmedCount`, `totalRequiredCount` vào `MissionLifecycleEventDto` và broadcast `MissionDispatched` tới tất cả các user được phân công.
8. **Route Giao diện Tiếp nhận**: Thống nhất dùng route hợp nhất `/missions/:id/confirmation` hiển thị tab động theo vai trò của người đăng nhập.

---

## 2. Câu trả lời Chi tiết theo Từng Nhóm Kỹ thuật & Nghiệp vụ

### 📌 Nhóm 1: Cơ sở dữ liệu & Model Quan hệ (Database Schema & EF Core)

#### ✅ Câu hỏi 1.1: Cấu trúc bảng phân công nhiệm vụ (`MissionAssignments`)
- **Hiện trạng Backend**: 
  - Backend **ĐÃ CÓ SẴN** bảng và Entity `MissionAssignment` liên kết quan hệ 1-N với `Missions` và N-1 với `Users`.
  - Cấu trúc Entity hiện tại trong `UavPms.OperationsService.Domain`:
    ```csharp
    public class MissionAssignment : BaseEntity
    {
        public Guid MissionId { get; set; }
        public Guid UserId { get; set; }
        public string AssignmentRole { get; set; } = string.Empty; // "INSPECTOR", "ANALYST", "TECHNICIAN"
        public MissionAssignmentStatus Status { get; set; } = MissionAssignmentStatus.Active; // Active, Unavailable, Revoked
        public MissionAssignmentResponse ResponseStatus { get; set; } = MissionAssignmentResponse.Pending; // Pending, Accepted, Postponed, Replaced, Cancelled
        public bool IsRequired { get; set; } = true;
        public DateTime AssignedAt { get; set; } = DateTime.UtcNow;
        public DateTime? RespondedAt { get; set; }
        public string? ResponseReason { get; set; }
        public uint Version { get; set; } = 1;
        public Guid AssignedByUserId { get; set; }
        public DateTime? EndedAt { get; set; }
        public virtual Mission? Mission { get; set; }
        public virtual User? User { get; set; }
    }
    ```
  - Các trường cũ trên bảng `Missions` (`InspectorId`, `AssignedToUserId`) chỉ được giữ lại để tương thích ngược (Backward Compatibility) và trỏ tới Primary Inspector. Toàn bộ nghiệp vụ kiểm tra đa vai trò sẽ query trực tiếp trên tập hợp `mission.Assignments`.

#### ✅ Câu hỏi 1.2: Định dạng Role trong Database và API
- **Quy chuẩn thống nhất**:
  - Backend đồng ý và **chuẩn hóa 100% trả về dạng chuỗi ký tự hoa (String Enum)** trong JSON:
    $$\text{"INSPECTOR"} \quad\Big|\quad \text{"ANALYST"} \quad\Big|\quad \text{"TECHNICIAN"}$$
  - *(Lưu ý: Nếu hệ thống có cấu hình Technician chuyên sâu, chuỗi định danh nội bộ có thể là `"MAINTENANCE_TECHNICIAN"`, nhưng tại tầng DTO giao tiếp với FE sẽ map chuẩn hóa về `"TECHNICIAN"`).*

---

### 📌 Nhóm 2: API Phân công & Tạo Nhiệm vụ (MF02 Create Mission API)

#### ✅ Câu hỏi 2.1: Payload tạo nhiệm vụ
- **Phương án lựa chọn**: Backend chọn **Phương án A (Mảng đồng nhất)**.
- **Hiện trạng & Khả năng đáp ứng**: 
  - Tại endpoint `POST /api/v2/pre-mission-assessments/{id}/create-mission`, DTO hiện tại là `CreateMissionFromAssessmentRequest` nhận thuộc tính `Personnel`:
    ```json
    {
      "assessmentId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "title": "Kiểm tra định kỳ ĐZ 220kV Sông Mây - Long Thành",
      "description": "Chú ý khoảng cách an toàn với pha giữa",
      "personnel": [
        { "userId": "usr-inspector-01", "role": "INSPECTOR", "isRequired": true },
        { "userId": "usr-analyst-02", "role": "ANALYST", "isRequired": true },
        { "userId": "usr-technician-03", "role": "TECHNICIAN", "isRequired": true }
      ],
      "droneIds": ["drone-matrice-350-01"],
      "idempotencyKey": "idem-key-12345"
    }
    ```
  - **Hỗ trợ thêm cho FE**: Backend sẽ bổ sung alias `JsonPropertyName("assignments")` cho `Personnel` để FE có thể gửi key `assignments` hoặc `personnel` đều hợp lệ.

#### ✅ Câu hỏi 2.2: Ràng buộc tối thiểu 3 vai trò & Mã lỗi
- **Xử lý phía Backend**:
  - Khi nhận request, Backend sẽ validate tập `Personnel`/`Assignments`. Nếu thiếu bất kỳ vai trò nào trong 3 vai trò bắt buộc (`INSPECTOR`, `ANALYST`, `TECHNICIAN`), Backend sẽ ngắt transaction và trả về **`422 Unprocessable Entity`** (hoặc `400 Bad Request`) với JSON:
    ```json
    {
      "success": false,
      "errorCode": "INSUFFICIENT_ROLES_ASSIGNED",
      "message": "Nhiệm vụ bắt buộc phải phân công đủ ít nhất 3 vai trò: Inspector, Analyst và Technician.",
      "missingRoles": ["ANALYST"]
    }
    ```

---

### 📌 Nhóm 3: Vòng đời Xác nhận & Trạng thái Tổng hợp (Confirmation Workflow & Lifecycle)

#### ✅ Câu hỏi 3.1: Endpoints tiếp nhận phản hồi (Accept / Postpone)
- **Phương án Backend hỗ trợ**: Hỗ trợ **cả 2 cách**, ưu tiên **Cách 2 kết hợp Cách 1**:
  1. **Cách 2 (Tiện lợi cho User - Khuyến nghị dùng)**:
     - `POST /api/v2/missions/{missionId}/assignments/accept`
     - `POST /api/v2/missions/{missionId}/assignments/postpone` (Body: `{ "reason": "..." }`)
     - *Cơ chế*: Backend tự lấy `UserId` từ JWT Token và tìm bản ghi `MissionAssignment` của User đó trong Mission. Nhân sự không cần truyền `assignmentId`.
  2. **Cách 1 (Tường minh theo AssignmentId)**:
     - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/accept`
     - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/postpone`
     - Backend sẽ alias route này để FE tùy chọn sử dụng.

#### ✅ Câu hỏi 3.2: Quy tắc chuyển trạng thái tổng thể của Mission
- **Trường hợp 1 (Inspector Accept, Analyst/Technician chưa phản hồi)**:
  - Trạng thái `Mission.Status` giữ nguyên là `PendingAcceptance` (tương đương `PENDING_CONFIRMATION` trên FE).
  - Backend cập nhật `MissionDto` bổ sung các trường tiến độ:
    ```json
    {
      "confirmedCount": 1,
      "totalRequiredCount": 3,
      "confirmationProgress": "1/3",
      "team": [
        {
          "assignmentId": "...",
          "userId": "...",
          "userName": "Nguyễn Văn A",
          "assignmentRole": "INSPECTOR",
          "responseStatus": "ACCEPTED",
          "respondedAt": "2026-09-25T08:00:00Z"
        }
      ]
    }
    ```
- **Trường hợp 2 (Có 1 người bấm Postpone)**:
  - Trạng thái Mission chuyển thành `Postponed` (hoặc cờ `requiresReassignment: true`).
  - **Quy tắc bảo lưu**: Các thành viên đã bấm `Accepted` trước đó **KHÔNG BỊ HỦY BỎ**, giữ nguyên trạng thái `Accepted`.
  - Backend gửi SignalR event `MissionPostponed` và Notification khẩn cấp đến Manager.
- **Trường hợp 3 (100% các vai trò bắt buộc đã Accept)**:
  - Logic `mission.CheckAcceptance()` tự động chuyển:
    $$\text{Status} \longrightarrow \text{Assigned (CONFIRMED)}$$
    $$\text{AcceptedAt} = \text{DateTime.UtcNow}$$
  - Backend tự động phát Notification và SignalR event `MissionConfirmed` gửi tới Manager và toàn bộ thành viên trong đội bay.

#### ✅ Câu hỏi 3.3: Cơ chế Reassign khi có người xin hoãn
- **Backend đồng thuận bổ sung Endpoint chuẩn**:
  - `POST /api/v2/missions/{missionId}/assignments/{assignmentId}/reassign`
  - **Payload**:
    ```json
    {
      "newUserId": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "reassignReason": "Thay thế do KTV A xin dời lịch"
    }
    ```
  - **Quy trình xử lý dưới Backend**:
    1. Chuyển bản ghi cũ của thành viên hoãn sang `Status = Revoked`, `ResponseStatus = Replaced`, ghi nhận `EndedAt = UtcNow`.
    2. Giải phóng `ResourceBooking` cũ của người này.
    3. Kiểm tra tính khả dụng của `newUserId` (Scope, Lịch trùng, Role).
    4. Tạo mới `MissionAssignment` cho `newUserId` với `ResponseStatus = Pending`, `IsRequired = true`.
    5. Tạo mới `ResourceBooking` cho `newUserId`.
    6. Chuyển trạng thái Mission quay lại `PendingAcceptance`.
    7. Phát SignalR event `MissionDispatched` trực tiếp đến `newUserId` và broadcast `MissionUpdated` cho nhóm nhiệm vụ.

#### ✅ Câu hỏi 3.4: Xử lý Quá hạn Xác nhận (`confirmationDeadline`)
- **Cơ chế hiện tại của Backend**:
  - Backend **ĐÃ CÓ** Background Job `MissionConfirmationOverdueJob` quét định kỳ qua Hangfire.
  - **Nguyên tắc xử lý**: 
    - Khi quá hạn, hệ thống **KHÔNG HỦY hay khóa cứng** nhiệm vụ (vì thực tế hiện trường đội bay có thể xác nhận trễ do sóng viễn thông yếu).
    - Job đánh dấu `IsOverdueNotified = true`.
    - Tạo Notification cảnh báo khẩn cấp tới Manager.
    - Ghi bản ghi `MissionCommunicationLog` loại `OVERDUE`.
    - Bắn SignalR event `OVERDUE` để Frontend hiển thị cảnh báo đỏ nhấp nháy.
    - Thành viên vẫn có thể bấm `Accept` nếu Manager chưa thực hiện Hủy nhiệm vụ (`CancelMission`).

---

### 📌 Nhóm 4: Đánh giá Tính khả dụng Nhân sự tại MF01 (Personnel Readiness Evaluation)

#### ✅ Câu hỏi 4.1: API danh sách ứng viên tiềm năng & Bộ lọc 5 tiêu chí
- **Hiện trạng & Kế hoạch mở rộng**:
  - Hiện tại Backend có `PersonnelEligibilityPolicy.cs` đã kiểm tra 4/5 tiêu chí cho Inspector.
  - Backend mở rộng hàm này để đánh giá cho cả 3 vai trò: `Inspector`, `Analyst`, và `MaintenanceTechnician`.
  - Backend cung cấp endpoint:
    `GET /api/v2/pre-mission-assessments/{id}/personnel-candidates`
    DTO trả về đảm bảo cấu trúc chi tiết:
    ```json
    [
      {
        "id": "usr-01",
        "name": "Nguyễn Văn A",
        "role": "INSPECTOR",
        "regionId": "reg-dong-nai",
        "regionName": "PC Đồng Nai",
        "isActive": true,
        "isEligible": true,
        "isWithinScope": true,
        "isAvailable": true,
        "overallEligibility": "ELIGIBLE",
        "qualificationDetails": "Chứng chỉ điều khiển UAV cấp 2, An toàn điện bậc 4/5",
        "scheduleConflict": null,
        "reasonCode": null,
        "reason": "Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành"
      }
    ]
    ```

#### ✅ Câu hỏi 4.2: Cấu hình số lượng nhân sự yêu cầu (Headcount per Role)
- **Phương án Backend**:
  - Thêm cấu hình số lượng vào `CreateAssessmentRequest`:
    ```json
    {
      "requiredInspectors": 1,
      "requiredAnalysts": 1,
      "requiredTechnicians": 1
    }
    ```
    *(Mặc định nếu FE không truyền sẽ là `1` cho mỗi vai trò).*
  - Điều kiện `assessment.PersonnelFeasibility` đạt `PASS` khi và chỉ khi:
    $$\text{Eligible(Inspectors)} \ge \text{ReqInspectors} \;\land\; \text{Eligible(Analysts)} \ge \text{ReqAnalysts} \;\land\; \text{Eligible(Techs)} \ge \text{ReqTechs}$$

---

### 📌 Nhóm 5: SignalR Hub & Real-time Events Đa Vai trò

#### ✅ Câu hỏi 5.1: Cơ chế bắn Realtime khi Dispatch nhiệm vụ
- **Hiện trạng & Điều chỉnh**:
  - Trong `NotificationHub.cs`, hiện tại `MissionDispatched` mới chỉ bắn vào `UserGroupName(inspectorGuid)`.
  - **Backend cam kết sửa**: Khi phát `MissionDispatched`, Backend sẽ lặp qua toàn bộ danh sách `UserId` được phân công trong Mission (cả Inspector, Analyst, Technician) và gửi tới:
    - Group cá nhân từng user: `Clients.Group($"user:{userId}").SendAsync("MissionDispatched", evt)`
    - Group chung của mission: `Clients.Group($"mission_{missionId}").SendAsync("MissionDispatched", evt)`
  - Đảm bảo thanh Navigation Bar của cả 3 nhân sự đều nhận chuông thông báo và popup tiếp nhận.

#### ✅ Câu hỏi 5.2: Dữ liệu gửi kèm trong SignalR Event
- Backend đồng ý mở rộng `MissionLifecycleEventDto` với các trường phong phú:
  ```csharp
  public class MissionLifecycleEventDto
  {
      public string MissionId { get; set; }
      public string Type { get; set; } // "DISPATCHED", "CONFIRMED", "POSTPONED", etc.
      public string? Status { get; set; }
      public string? AssignmentId { get; set; } // ID bản ghi phân công liên quan
      public string? ActorId { get; set; }
      public string? ActorName { get; set; }
      public string? ActorRole { get; set; } // "INSPECTOR", "ANALYST", "TECHNICIAN", "MANAGER"
      public bool AllConfirmed { get; set; } // true khi 100% đã accept
      public int ConfirmedCount { get; set; }
      public int TotalRequiredCount { get; set; }
      public List<string> PendingRoles { get; set; } = new(); // vd: ["ANALYST"]
      public string? Reason { get; set; }
      public DateTime Timestamp { get; set; } = DateTime.UtcNow;
  }
  ```

---

### 📌 Nhóm 6: Giao diện Tiếp nhận Nhiệm vụ Phía Nhân sự (Front-facing Consoles)

#### ✅ Câu hỏi 6.1: Hướng tiếp cận Route cho 3 vai trò
- **Backend khuyến nghị**: **Ủng hộ 100% Phương án 1 (Hợp nhất: `/missions/:id/confirmation`)**.
- **Lý do & Hỗ trợ RBAC từ Backend**:
  - Giao diện Adaptive (thích ứng) theo Role giúp tối ưu trải nghiệm, tránh trùng lặp code route trên Frontend.
  - Về phía Backend:
    - Các API chi tiết nhiệm vụ và chấp thuận/xin hoãn được gán Policy:
      `[Authorize(Roles = UserRoles.AllAuthenticatedRoles)]`
      (Bao gồm cả `SystemAdmin`, `Manager`, `Inspector`, `Analyst`, `MaintenanceTechnician`).
    - Dữ liệu trả về từ `GET /api/v2/missions/{id}` đã bao gồm đầy đủ dữ liệu thời tiết, GIS, thiết bị mục tiêu và thông số kỹ thuật UAV, cho phép FE hiển thị tab tương ứng cho từng vai trò mà không bị lỗi phân quyền (403 Forbidden).

---

## 3. Bảng Ma trận Yêu cầu Đã Thống nhất (Decision Matrix)

| STT | Vấn đề kỹ thuật | Đề xuất từ Frontend | Trạng thái Backend | Ghi chú & Cam kết Backend |
| :---: | :--- | :--- | :---: | :--- |
| **1** | Bảng lưu trữ phân công đa vai trò | Tạo bảng quan hệ `MissionAssignments` | ✅ **Đã có sẵn** | Entity `MissionAssignment` đã hoạt động, liên kết 1-N. |
| **2** | Tên vai trò chuẩn trong API | `"INSPECTOR"`, `"ANALYST"`, `"TECHNICIAN"` (String Enum) | ✅ **Đồng ý 100%** | Thống nhất trả về chuỗi ký tự hoa, không dùng số nguyên Enum. |
| **3** | Payload tạo nhiệm vụ (`POST .../create-mission`) | Sử dụng mảng `assignments: [{ userId, role }]` | ✅ **Đã hỗ trợ** | Hỗ trợ cả key `personnel` và `assignments` với `isRequired: true`. |
| **4** | Ràng buộc tối thiểu tạo nhiệm vụ | Bắt buộc đủ 3 vai trò, mỗi vai trò $\ge 1$ người | ✅ **Đồng ý** | Trả về `422 Unprocessable Entity` + `INSUFFICIENT_ROLES_ASSIGNED` nếu thiếu. |
| **5** | Endpoint Accept / Postpone | Hỗ trợ theo ngữ cảnh JWT hoặc AssignmentId | ✅ **Đã có sẵn** | Hỗ trợ `POST .../assignments/accept` và `POST .../assignments/postpone`. |
| **6** | Endpoint Reassign khi hoãn | `POST .../assignments/{id}/reassign` | 🔄 **Đang triển khai** | Sẽ bổ sung endpoint chuyên biệt đổi người và giải phóng booking cũ. |
| **7** | Trạng thái Mission chuyển `CONFIRMED` | Chỉ khi 100% các vai trò bắt buộc đã Accept | ✅ **Đã chuẩn hóa** | Logic `CheckAcceptance()` tự động kích hoạt khi đủ 3 vai trò. |
| **8** | Bộ lọc 5 tiêu chí nhân sự MF01 | Backend lọc SQL/Policy theo Logic AND | ✅ **Đồng ý** | Mở rộng `PersonnelEligibilityPolicy` cho Analyst & Tech. |
| **9** | SignalR Payload | Bổ sung `actorRole`, `allConfirmed`, `pendingRoles` | 🔄 **Đang triển khai** | Bổ sung các trường vào `MissionLifecycleEventDto`. |
| **10**| Màn hình tiếp nhận nhiệm vụ | Thống nhất route `/missions/:id/confirmation` | ✅ **Đồng ý 100%** | Backend mở rộng Policy cho `MaintenanceTechnician` truy cập. |
