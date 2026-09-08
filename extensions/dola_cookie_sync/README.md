# Dola & Social Cookie Sync - Chrome Extension

Tiện ích mở rộng Chrome giúp xuất và đồng bộ Cookie (Dola, Facebook, v.v.) trực tiếp vào **Dola Render Gateway** chỉ với 1 cú click, không cần nhập tài khoản/mật khẩu, tránh hoàn toàn bot detection, CAPTCHA hay 2FA của Google/Dola.

---

## 🚀 Hướng Dẫn Cài Đặt (30 giây)

1. Mở trình duyệt Chrome, truy cập: `chrome://extensions`
2. Bật chế độ nhà phát triển (**Developer mode**) ở góc trên bên phải.
3. Nhấn nút **Tải tiện ích đã giải nén** (**Load unpacked**).
4. Chọn thư mục:
   ```
   /Volumes/Data/dola-render-gateway/extensions/dola_cookie_sync
   ```
5. Tiện ích **Dola & Social Cookie Sync** sẽ xuất hiện trên thanh công cụ của Chrome (bạn có thể bấm biểu tượng ghim 📌 để tiện sử dụng).

---

## 🎯 Hướng Dẫn Sử Dụng

### 1. Đồng bộ 1-Click (Khuyên dùng)
1. Mở tab mới trên Chrome và đăng nhập vào tài khoản Dola (`https://dola.com`) hoặc Facebook (`https://facebook.com`).
2. Nhấn vào biểu tượng extension **Cookie Sync** trên thanh công cụ.
3. Extension sẽ tự động nhận diện domain và số lượng cookie:
   - Dola: kiểm tra token `sessionid`.
   - Facebook: kiểm tra token `c_user`.
4. Nhập tên tài khoản (Account ID) mong muốn (hoặc để mặc định, vd: `dola_102`).
5. Đảm bảo Gateway URL là `http://127.0.0.1:8000`.
6. Nhấn nút **⚡ 1-Click Sync to Gateway**.
7. Dashboard Gateway tại `http://127.0.0.1:8000` sẽ lập tức xuất hiện tài khoản mới ở trạng thái **Active**!

---

### 2. Copy JSON dán vào Dashboard thủ công (Tuỳ chọn)
1. Trong popup extension, nhấn **📋 Copy JSON to Clipboard**.
2. Mở Dashboard Gateway `http://127.0.0.1:8000`, chuyển sang tab **Accounts**.
3. Bấm **＋ Import Cookie**.
4. Dán mã JSON đã copy vào ô Cookie & bấm **Import & Activate**.

---

## ⚙️ Tính Năng Nổi Bật
- **Hỗ trợ đa nền tảng**: Dola, Facebook và tuỳ biến domain hiện tại.
- **Bảo mật**: Dữ liệu chỉ gửi trực tiếp về Gateway cục bộ `127.0.0.1:8000` của bạn, không qua bất kỳ bên thứ 3 nào.
- **Tự động lưu cấu hình**: Gateway URL và Admin Key được lưu tự động cho các lần sử dụng tiếp theo.
