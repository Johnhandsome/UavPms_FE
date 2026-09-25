# [BACKEND ISSUE] KHẮC PHỤC LỖI TÀI KHOẢN INSPECTOR KHÔNG NHẬN ĐƯỢC THÔNG BÁO VÀ DANH SÁCH NHIỆM VỤ ĐƯỢC PHÂN CÔNG (MF02)

- **Mã Issue**: `ISSUE-BE-MF02-007`
- **Mức độ nghiêm trọng**: 🔴 **CRITICAL / BLOCKER** (Chặn quy trình vận hành thực tế của Thanh tra viên)
- **Hệ thống**: Backend API & SignalR Service (ASP.NET Core / PostgreSQL / SQL Server)
- **Module liên quan**: `MissionsController`, `NotificationsController`, `MissionAssignmentService`, `NotificationHub`

---

## 1. Mô Tả Hiện Tượng (Problem Statement)

Khi người dùng đăng nhập bằng tài khoản Thanh tra viên (`inspector` / role `INSPECTOR`):
1. **Trang nhiệm vụ bay (`/missions`)**: Trước đây không hiển thị bất kỳ nhiệm vụ nào ("Không có nhiệm vụ phù hợp") do gọi `GET /api/v1/missions/my` bị backend trả về `HTTP 404 Not Found`.
2. **Khung thông báo Header (Chuông thông báo)**: Trống trơn, không có bất kỳ thông báo phân công nhiệm vụ (`MISSION_DISPATCH`) nào được gửi từ phía Backend sau khi Manager tạo nhiệm vụ.
3. **Realtime**: Không nhận được sự kiện SignalR thông báo khi Manager ban hành chuyến bay.

> **Trạng thái xử lý tạm thời phía Frontend**:
> Frontend đã bổ sung cơ chế fallback: Nếu `GET /api/v1/missions/my` bị 404, hệ thống tự động gọi `GET /api/v1/missions` để hiển thị toàn bộ nhiệm vụ. Đồng thời, `NotificationsStore` tự quét dữ liệu nhiệm vụ để sinh thông báo offline.
> **TUY NHIÊN**, để hệ thống vận hành đúng quy chuẩn multi-tenant và multi-role, Backend **BẮT BUỘC** phải hỗ trợ các API và trigger dưới đây.

---

## 2. Chi Tiết Các Lỗi Backend Cần Khắc Phục

### Lỗi 1: Thiếu Endpoint `GET /api/v1/missions/my` (HTTP 404)

- **Mô tả**: Khi người dùng thuộc vai trò thao tác (Inspector, Analyst, Technician) truy cập hệ thống, frontend gọi endpoint lấy danh sách nhiệm vụ được gán trực tiếp cho họ.
- **Thực tế**: Backend chưa có route `/api/v1/missions/my`, dẫn đến HTTP 404.
- **Yêu cầu Backend**:
  - Triển khai endpoint `GET /api/v1/missions/my`.
  - Endpoint tự động lấy `CurrentUserId` từ JWT Claims của request hiện tại và query bảng `MissionAssignments` để trả về các nhiệm vụ mà user này được gán (bất kể role là INSPECTOR, ANALYST hay TECHNICIAN).
  - Hoặc nếu dùng chung endpoint `GET /api/v1/missions`, cần hỗ trợ query param: `GET /api/v1/missions?assignedUserId={userId}` hoặc `GET /api/v1/missions?myOnly=true`.

#### Đặc Tả API `GET /api/v1/missions/my`

- **Endpoint**: `GET /api/v1/missions/my`
- **Headers**: `Authorization: Bearer <JWT_TOKEN>`
- **Response**: `200 OK`
```json
{
  "success": true,
  "data": [
    {
      "id": "msn-20260329-001",
      "missionCode": "MSN-20260329-001",
      "title": "Khảo sát đường dây 220kV Hòa Bình - Nho Quan",
      "description": "Kiểm tra định kỳ độ võng và phụ kiện cách điện khoảng cột 12-25",
      "status": "PENDING_CONFIRMATION",
      "assignedToUserId": "usr-inspector-01",
      "assignedToUsername": "inspector",
      "droneId": "drn-matrice-300-01",
      "droneCode": "DRN-M300-01",
      "confirmationDeadline": "2026-09-26T08:00:00Z",
      "managerInstructions": "Kiểm tra kỹ khoảng cột 15 sau đợt mưa bão",
      "createdAt": "2026-09-25T10:00:00Z",
      "updatedAt": "2026-09-25T10:00:00Z"
    }
  ]
}
```

---

### Lỗi 2: Thiếu Endpoint Lấy Lịch Sử Thông Báo `GET /api/v1/notifications/history`

- **Mô tả**: Khi người dùng vào ứng dụng, `NotificationsStore` gọi API để lấy lịch sử các thông báo của user:
  `GET /api/v1/notifications/history?userId={userId}` (hoặc `GET /api/v1/notifications`).
- **Thực tế**: Endpoint trả về 404 hoặc không trả về danh sách thông báo đã lưu trong Database.
- **Yêu cầu Backend**:
  - Cung cấp endpoint: `GET /api/v1/notifications/history?userId={userId}&limit=50`.
  - Cung cấp endpoint: `PUT /api/v1/notifications/{id}/read` (đánh dấu đã đọc).
  - Cung cấp endpoint: `DELETE /api/v1/notifications/{id}` (xóa thông báo).

#### Schema DTO `NotificationResponseDto`
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "notif-uuid-001",
        "userId": "usr-inspector-01",
        "title": "[MF02 ĐIỀU PHỐI] Yêu cầu xác nhận nhiệm vụ: MSN-20260329-001",
        "body": "Bạn được phân công tham gia nhiệm vụ \"Khảo sát đường dây 220kV Hòa Bình - Nho Quan\". Hạn chót xác nhận: 26/09/2026 08:00.",
        "type": "MISSION_DISPATCH",
        "referenceType": "MISSION",
        "referenceId": "msn-20260329-001",
        "isRead": false,
        "createdAt": "2026-09-25T10:00:00Z"
      }
    ],
    "totalCount": 1
  }
}
```

---

### Lỗi 3: Chưa Lưu Thông Báo & Push SignalR Khi Tạo Nhiệm Vụ (`POST /api/v1/missions`)

- **Mô tả**: Khi Manager hoàn tất bước tạo và điều phối nhiệm vụ tại Frontend:
  - Frontend gửi request `POST /api/v1/missions` (kèm danh sách phân công `assignments: [{ userId, role, isRequired }]`).
  - Backend ghi nhận mission vào DB, **NHƯNG KHÔNG TỰ ĐỘNG SINH RECORD THÔNG BÁO CHO 3 NHÂN VIÊN ĐƯỢC PHÂN CÔNG**.
- **Hệ quả**: Khi `inspector` đăng nhập vào máy của mình, bảng `Notifications` của họ trống trơn!
- **Yêu cầu Backend**:
  Ngay trong Transaction của API Tạo / Điều Phối nhiệm vụ (`POST /api/v1/missions` hoặc `/api/v2/pre-mission-assessments/{id}/create-mission`):
  1. Với mỗi nhân viên trong `assignments` (Inspector, Analyst, Technician):
     - Ghi 1 bản ghi vào bảng `Notifications`:
       - `UserId`: ID của nhân sự được phân công.
       - `Title`: `$"[MF02 ĐIỀU PHỐI] Yêu cầu xác nhận nhiệm vụ: {mission.MissionCode}"`
       - `Body`: `$"Bạn được phân công đảm nhận vai trò {assignment.Role} cho nhiệm vụ \"{mission.Title}\". Hạn chót xác nhận: {mission.ConfirmationDeadline:dd/MM/yyyy HH:mm}."`
       - `Type`: `"MISSION_DISPATCH"`
       - `ReferenceType`: `"MISSION"`
       - `ReferenceId`: `mission.Id`
       - `IsRead`: `false`
       - `CreatedAt`: `DateTime.UtcNow`
  2. Bắn SignalR Realtime tới Group của User đó:
     - `await _hubContext.Clients.User(assignment.UserId).SendAsync("ReceiveNotification", notificationDto);`
     - `await _hubContext.Clients.User(assignment.UserId).SendAsync("ReceiveMissionEvent", new MissionLifecycleEventDto { Type = "DISPATCHED", MissionId = mission.Id, ... });`

---

## 3. Mã Nguồn Tham Khảo C# Cho Đội Ngũ Backend

### 3.1. Controller Endpoint `GET /api/v1/missions/my`

```csharp
[ApiController]
[Route("api/v1/missions")]
[Authorize]
public class MissionsController : ControllerBase
{
    private readonly IMissionService _missionService;

    public MissionsController(IMissionService missionService)
    {
        _missionService = missionService;
    }

    [HttpGet("my")]
    public async Task<IActionResult> GetMyMissions()
    {
        // Lấy UserId của user đang đăng nhập từ JWT Token
        var currentUserId = User.FindFirstValue(ClaimTypes.NameIdentifier) 
                         ?? User.FindFirstValue("sub") 
                         ?? User.FindFirstValue("uid");

        if (string.IsNullOrEmpty(currentUserId))
        {
            return Unauthorized(new { success = false, message = "Không xác thực được danh tính người dùng." });
        }

        var missions = await _missionService.GetMissionsByAssignedUserAsync(currentUserId);
        return Ok(new { success = true, data = missions });
    }
}
```

---

### 3.2. Trigger Tự Động Sinh Thông Báo Khi Dispatch Nhiệm Vụ

```csharp
public async Task<MissionDto> CreateMissionAsync(CreateMissionRequest request, string managerId)
{
    using var transaction = await _dbContext.Database.BeginTransactionAsync();

    // 1. Tạo bản ghi Mission
    var mission = new Mission
    {
        Id = "msn-" + Guid.NewGuid().ToString("N")[..8],
        MissionCode = await GenerateMissionCodeAsync(),
        Title = request.Title,
        Description = request.Description,
        Status = MissionStatus.PendingConfirmation, // Chờ 3 bên xác nhận
        ConfirmationDeadline = request.ConfirmationDeadline ?? DateTime.UtcNow.AddHours(24),
        ManagerInstructions = request.ManagerInstructions,
        CreatedAt = DateTime.UtcNow
    };

    _dbContext.Missions.Add(mission);

    // 2. Lưu danh sách Assignments
    foreach (var a in request.Assignments)
    {
        var assignment = new MissionAssignment
        {
            Id = Guid.NewGuid().ToString(),
            MissionId = mission.Id,
            UserId = a.UserId,
            Role = a.Role, // "INSPECTOR" | "ANALYST" | "TECHNICIAN"
            IsRequired = a.IsRequired,
            Status = AssignmentStatus.Pending
        };
        _dbContext.MissionAssignments.Add(assignment);

        // 3. TẠO THÔNG BÁO CHO TỪNG NHÂN SỰ
        var notif = new Notification
        {
            Id = "notif-" + Guid.NewGuid().ToString("N")[..10],
            UserId = a.UserId,
            Title = $"[MF02 ĐIỀU PHỐI] Yêu cầu xác nhận nhiệm vụ: {mission.MissionCode}",
            Body = $"Bạn được phân công làm {a.Role} trong nhiệm vụ \"{mission.Title}\". Hạn chót xác nhận: {mission.ConfirmationDeadline:dd/MM/yyyy HH:mm}. Lời dặn: \"{mission.ManagerInstructions}\"",
            Type = "MISSION_DISPATCH",
            ReferenceType = "MISSION",
            ReferenceId = mission.Id,
            IsRead = false,
            CreatedAt = DateTime.UtcNow
        };
        _dbContext.Notifications.Add(notif);

        // 4. Bắn SignalR Realtime tới cá nhân được gán
        await _notificationHub.Clients.User(a.UserId).SendAsync("ReceiveNotification", new
        {
            id = notif.Id,
            userId = notif.UserId,
            title = notif.Title,
            body = notif.Body,
            type = notif.Type,
            referenceType = notif.ReferenceType,
            referenceId = notif.ReferenceId,
            isRead = false,
            createdAt = notif.CreatedAt
        });
    }

    await _dbContext.SaveChangesAsync();
    await transaction.CommitAsync();

    return _mapper.Map<MissionDto>(mission);
}
```

---

### 3.3. Controller Endpoint `NotificationsController`

```csharp
[ApiController]
[Route("api/v1/notifications")]
[Authorize]
public class NotificationsController : ControllerBase
{
    private readonly INotificationService _notificationService;

    public NotificationsController(INotificationService notificationService)
    {
        _notificationService = notificationService;
    }

    [HttpGet("history")]
    public async Task<IActionResult> GetHistory([FromQuery] string? userId, [FromQuery] int limit = 50)
    {
        var currentUserId = userId ?? User.FindFirstValue(ClaimTypes.NameIdentifier);
        var notifs = await _notificationService.GetHistoryByUserIdAsync(currentUserId, limit);
        return Ok(new { success = true, data = notifs });
    }

    [HttpPut("{id}/read")]
    public async Task<IActionResult> MarkRead(string id)
    {
        await _notificationService.MarkAsReadAsync(id);
        return Ok(new { success = true, data = new { id, isRead = true } });
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id)
    {
        await _notificationService.DeleteAsync(id);
        return Ok(new { success = true, data = id });
    }
}
```

---

## 4. Bảng Kiểm Tra Chấp Thuận (Acceptance Criteria)

- [ ] `GET /api/v1/missions/my` trả về `200 OK` cùng danh sách nhiệm vụ được gán cho user hiện tại.
- [ ] Khi Manager tạo chuyến bay (`POST /api/v1/missions`), trong Database bảng `Notifications` tự động có 3 records tương ứng cho `inspector`, `analyst`, `technician`.
- [ ] `GET /api/v1/notifications/history?userId={userId}` trả về danh sách thông báo đầy đủ kèm trạng thái `isRead`.
- [ ] Khi đăng nhập bằng `inspector`, popup chuông thông báo hiển thị thông báo `[MF02 ĐIỀU PHỐI]` và nút "Đến trang nhiệm vụ" chuyển hướng trực tiếp tới `/missions/{id}/inspector`.
- [ ] Trang `/missions` hiển thị đầy đủ danh sách nhiệm vụ với số liệu thống kê (Stats strip).
