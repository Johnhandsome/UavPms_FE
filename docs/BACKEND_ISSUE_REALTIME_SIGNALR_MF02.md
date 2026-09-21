# 📋 BACKEND GITHUB ISSUE: TRIỂN KHAI SIGNALR HUB & REALTIME EVENTS CHO VÒNG ĐỜI NHIỆM VỤ BAY (MF02)

> **Mục đích**: Tài liệu này là mẫu Issue kỹ thuật hoàn chỉnh để sao chép trực tiếp lên kho lưu trữ Backend (ASP.NET Core / C# / EF Core).  
> **Frontend Status**: Đã hoàn thành triển khai Client listener, emitter và fallback synchronization trên Angular 20 Standalone.  
> **Ưu tiên (Priority)**: 🔴 **Cao (High - Blocker cho đồng bộ đa vai trò)**.

---

## 📌 Tiêu đề Issue (Title)
`[Backend/SignalR] Triển khai Hub Methods & Push Events Real-time cho Vòng đời Điều phối Nhiệm vụ Bay (MF02)`

**Labels**: `backend`, `signalr`, `realtime`, `MF02`, `high-priority`

---

## 1. Bối cảnh & Mục tiêu (Context & Objective)
Frontend hiện đã hoàn thành giao diện điều phối cho **Quản lý vận hành (Manager)** tại `/missions/:id` và **Thanh tra viên / Phi công UAV (Inspector)** tại `/missions/:id/inspector`, cùng trang danh sách `/missions`.

Để đảm bảo hai vai trò tương tác và cập nhật trạng thái với nhau theo thời gian thực mà **không cần tải lại trang (F5)**, Backend cần:
1. Mở rộng SignalR Hub (mặc định tại `/hubs/notifications`) hỗ trợ cơ chế Group theo `missionId`.
2. Tiếp nhận và phát sóng (broadcast) các sự kiện vòng đời nhiệm vụ bay (`MissionLifecycleRealtimeEvent`) tới đúng các Client đang theo dõi.
3. Kích hoạt thông báo tự động (Notification) và lưu vết vào cơ sở dữ liệu (`Missions`, `CommunicationLogs`, `Notifications`).
4. Triển khai Background Service quét tự động cảnh báo quá hạn tiếp nhận (`MissionConfirmationOverdue`).

---

## 2. Đặc tả Kỹ thuật SignalR Hub (Technical Specification)

### 2.1. Hub Endpoint & Route
- **Route URL**: `/hubs/notifications` (hoặc `/hubs/missions`)
- **Authentication**: JWT Bearer Token truyền qua `access_token` query parameter khi bắt đầu WebSocket Handshake:
  ```csharp
  options.Events = new JwtBearerEvents
  {
      OnMessageReceived = context =>
      {
          var accessToken = context.Request.Query["access_token"];
          var path = context.HttpContext.Request.Path;
          if (!string.IsNullOrEmpty(accessToken) && path.StartsWithSegments("/hubs/notifications"))
          {
              context.Token = accessToken;
          }
          return Task.CompletedTask;
      }
  };
  ```

### 2.2. Client-to-Server Hub Methods (Client gọi lên Server)

Backend Hub cần cung cấp các phương thức sau để Client đăng ký nhận sự kiện theo nhiệm vụ:

```csharp
public class NotificationsHub : Hub
{
    // 1. Client tham gia phòng nhiệm vụ cụ thể
    public async Task JoinMissionGroup(string missionId)
    {
        if (!string.IsNullOrWhiteSpace(missionId))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, $"mission_{missionId}");
        }
    }

    // 2. Client rời phòng khi navigate sang trang khác
    public async Task LeaveMissionGroup(string missionId)
    {
        if (!string.IsNullOrWhiteSpace(missionId))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, $"mission_{missionId}");
        }
    }

    // 3. Client gửi sự kiện vòng đời trực tiếp qua Hub (tùy chọn bên cạnh REST API)
    public async Task SendMissionEvent(MissionLifecycleEventDto evt)
    {
        if (evt == null || string.IsNullOrWhiteSpace(evt.MissionId)) return;

        // Broadcast tới toàn bộ client trong nhóm nhiệm vụ
        await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionLifecycleEvent", evt);

        // Phát riêng rẽ theo tên event tương ứng để tương thích với các client cũ
        switch (evt.Type?.ToUpper())
        {
            case "CONFIRMED":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionConfirmed", evt);
                break;
            case "SUSPENDED":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionSuspended", evt);
                break;
            case "POSTPONED":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionPostponed", evt);
                break;
            case "RESUMED":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionResumed", evt);
                break;
            case "CANCELLED":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionCancelled", evt);
                break;
            case "REMINDER":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionReminderSent", evt);
                break;
            case "COMMUNICATION":
                await Clients.Group($"mission_{evt.MissionId}").SendAsync("MissionCommunicationReceived", evt);
                break;
        }
    }
}
```

---

## 3. Server-to-Client Push Events (Server phát xuống Client)

Khi các API REST thực hiện thay đổi trạng thái nhiệm vụ, Backend cần inject `IHubContext<NotificationsHub>` và phát sự kiện:

| Tên Event SignalR | Mục đích | Đối tượng nhận | Dữ liệu Payload gửi kèm |
| :--- | :--- | :--- | :--- |
| `MissionDispatched` | Quản lý vừa tạo & ban hành nhiệm vụ mới | `Clients.User(inspectorUserId)` & `Clients.All` | `{ missionId, type: "DISPATCHED", status: "PENDING_CONFIRMATION", actorRole: "MANAGER", actorName, confirmationDeadline, managerInstructions, timestamp }` |
| `MissionConfirmed` | Phi công xác nhận tiếp nhận sẵn sàng bay | `Clients.Group($"mission_{id}")` | `{ missionId, type: "CONFIRMED", status: "CONFIRMED", actorRole: "INSPECTOR", actorName, reason, timestamp }` |
| `MissionPostponed` | Phi công xin hoãn / dời lịch | `Clients.Group($"mission_{id}")` | `{ missionId, type: "POSTPONED", status: "POSTPONED", reason, actorRole: "INSPECTOR", actorName, timestamp }` |
| `MissionSuspended` | Quản lý tạm đình chỉ bay khẩn cấp | `Clients.Group($"mission_{id}")` | `{ missionId, type: "SUSPENDED", status: "SUSPENDED", reason, actorRole: "MANAGER", actorName, timestamp }` |
| `MissionResumed` | Quản lý dỡ lệnh tạm đình chỉ | `Clients.Group($"mission_{id}")` | `{ missionId, type: "RESUMED", status: "CONFIRMED", actorRole: "MANAGER", actorName, timestamp }` |
| `MissionCancelled` | Quản lý hủy bỏ nhiệm vụ | `Clients.Group($"mission_{id}")` | `{ missionId, type: "CANCELLED", status: "Cancelled", reason, actorRole: "MANAGER", actorName, timestamp }` |
| `MissionReminderSent` | Quản lý bấm gửi nhắc nhở khẩn cấp | `Clients.Group($"mission_{id}")` & `Clients.User(inspectorId)` | `{ missionId, type: "REMINDER", reason, actorRole: "MANAGER", actorName, timestamp }` |
| `MissionCommunicationReceived` | Tin nhắn trao đổi 2 chiều giữa Manager & Inspector | `Clients.Group($"mission_{id}")` | `{ missionId, type: "COMMUNICATION", actorRole, actorName, message, timestamp, log: { id, senderId, senderName, senderRole, type: "MESSAGE", content, timestamp } }` |
| `MissionConfirmationOverdue` | Tự động quá hạn tiếp nhận từ Background Job | `Clients.Group($"mission_{id}")` & `Clients.User(managerId)` | `{ missionId, type: "OVERDUE", timestamp }` |
| `MissionLifecycleEvent` | **Event tổng hợp** chứa mọi sự kiện trên | `Clients.Group($"mission_{id}")` | `MissionLifecycleEventDto` |

---

## 4. Đặc tả C# Data Transfer Objects (DTOs)

```csharp
namespace UavPms.Application.DTOs.Realtime
{
    public class MissionLifecycleEventDto
    {
        public string MissionId { get; set; } = string.Empty;
        
        // Giá trị: "DISPATCHED" | "CONFIRMED" | "POSTPONED" | "SUSPENDED" | "RESUMED" | "CANCELLED" | "REMINDER" | "COMMUNICATION" | "OVERDUE"
        public string Type { get; set; } = string.Empty;
        
        // Giá trị: "PENDING_CONFIRMATION" | "CONFIRMED" | "POSTPONED" | "SUSPENDED" | "Cancelled"
        public string? Status { get; set; }
        
        public string? ConfirmationDeadline { get; set; }
        public string? ManagerInstructions { get; set; }
        public string? Reason { get; set; }
        public string? Message { get; set; }
        
        public string? ActorId { get; set; }
        public string? ActorName { get; set; }
        
        // "MANAGER" | "INSPECTOR" | "SYSTEM"
        public string? ActorRole { get; set; }
        
        public DateTime Timestamp { get; set; } = DateTime.UtcNow;
        
        public MissionCommunicationLogDto? Log { get; set; }
    }

    public class MissionCommunicationLogDto
    {
        public string Id { get; set; } = Guid.NewGuid().ToString();
        public string SenderId { get; set; } = string.Empty;
        public string SenderName { get; set; } = string.Empty;
        public string SenderRole { get; set; } = "SYSTEM"; // "MANAGER" | "INSPECTOR" | "SYSTEM"
        public string Type { get; set; } = "MESSAGE";       // "MESSAGE" | "DISPATCH" | "CONFIRM" | "POSTPONE" | "SUSPEND" | "RESUME" | "CANCEL" | "REMINDER"
        public string Content { get; set; } = string.Empty;
        public DateTime Timestamp { get; set; } = DateTime.UtcNow;
    }
}
```

---

## 5. Tích hợp tại Service / Controller Backend

Ví dụ khi gọi API Xác nhận nhiệm vụ `POST /api/missions/{id}/confirm`:

```csharp
[HttpPost("{id}/confirm")]
public async Task<IActionResult> ConfirmMission(string id, [FromBody] ConfirmMissionRequest request)
{
    var mission = await _missionService.ConfirmAsync(id, request, CurrentUserId);
    
    // 1. Tạo Notification cho Manager
    await _notificationService.CreateAsync(new CreateNotificationDto
    {
        UserId = mission.ManagerId,
        Title = $"[MF02] Phi công đã tiếp nhận nhiệm vụ {mission.MissionCode}",
        Body = $"Phi công {mission.AssignedToUsername} đã xác nhận tiếp nhận nhiệm vụ bay.",
        Type = "MISSION_CONFIRMED",
        ReferenceId = mission.Id,
        ReferenceType = "MISSION"
    });

    // 2. Broadcast SignalR Real-time Event
    var eventDto = new MissionLifecycleEventDto
    {
        MissionId = mission.Id,
        Type = "CONFIRMED",
        Status = "CONFIRMED",
        ActorId = CurrentUserId,
        ActorName = mission.AssignedToUsername,
        ActorRole = "INSPECTOR",
        Reason = request.Reason ?? "Phi công đã xác nhận sẵn sàng bay.",
        Timestamp = DateTime.UtcNow
    };

    await _hubContext.Clients.Group($"mission_{mission.Id}").SendAsync("MissionConfirmed", eventDto);
    await _hubContext.Clients.Group($"mission_{mission.Id}").SendAsync("MissionLifecycleEvent", eventDto);

    return Ok(mission);
}
```

Tương tự cho các endpoints:
- `POST /api/missions/{id}/suspend` (Phát `MissionSuspended`)
- `POST /api/missions/{id}/resume` (Phát `MissionResumed`)
- `POST /api/missions/{id}/postpone` (Phát `MissionPostponed`)
- `POST /api/missions/{id}/cancel` (Phát `MissionCancelled`)
- `POST /api/missions/{id}/remind` (Phát `MissionReminderSent`)
- `POST /api/missions/{id}/communications` (Phát `MissionCommunicationReceived`)
- `POST /api/missions` (Phát `MissionDispatched` tới `inspectorId`)

---

## 6. Background Worker: Cảnh báo Quá hạn Xác nhận (Overdue Job)

Tạo một `IHostedService` hoặc Hangfire Job định kỳ chạy mỗi 1 phút:
1. Truy vấn các nhiệm vụ có:
   ```sql
   status = 'PENDING_CONFIRMATION' AND confirmation_deadline < NOW() AND is_overdue_notified = false
   ```
2. Cập nhật cờ `is_overdue_notified = true`.
3. Bắn SignalR event `MissionConfirmationOverdue` tới Manager và Group `$"mission_{mission.Id}"`.
4. Tạo thông báo khẩn trong bảng `Notifications`.

---

## 7. Kế hoạch Kiểm thử & Nghiệm thu (Verification & Acceptance Criteria)
- [ ] Mở 2 trình duyệt:
  - Trình duyệt A: Đăng nhập vai trò **Quản lý (Manager)** tại trang `/missions/{id}`.
  - Trình duyệt B: Đăng nhập vai trò **Phi công (Inspector)** tại trang `/missions/{id}/inspector`.
- [ ] Tại trình duyệt B, bấm **"Xác nhận tiếp nhận nhiệm vụ"**:
  - Trình duyệt A đổi trạng thái ngay sang màu xanh `CONFIRMED` không cần F5.
- [ ] Tại trình duyệt A, bấm **"Tạm đình chỉ bay"**:
  - Trình duyệt B hiện ngay banner đỏ cảnh báo đình chỉ và khóa các nút bay.
- [ ] Tại trình duyệt A, gửi tin nhắn điều phối:
  - Trình duyệt B hiển thị tin nhắn trong khung chat ngay lập tức.
- [ ] Kết nối WebSocket giữ ổn định, tự động reconnect khi mạng chập chờn.
