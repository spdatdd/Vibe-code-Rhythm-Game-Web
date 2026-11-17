# ORBIT — Rhythm Lab

Game Piano Tiles chạy cục bộ bằng Node.js, Canvas và Web Audio. Code có comment tiếng Việt.

## Mở game

Nhấp đúp `Start-Game.cmd`, giữ cửa sổ server mở rồi truy cập **http://127.0.0.1:5173/**.
Hoặc chạy `node server.mjs` trong thư mục dự án. Máy chủ chỉ lắng nghe trên máy hiện tại.
Nếu vừa cập nhật server, tắt cửa sổ server cũ bằng Ctrl+C rồi chạy lại.

## Tự phân tích YouTube

1. Chọn **YouTube** và dán link. Sau khoảng một giây game tự bắt đầu chuẩn bị; cũng có thể bấm **Phân tích**.
2. Chờ các bước **tải âm thanh → chuẩn hóa → dò điểm khởi âm → nạp âm thanh vào bộ nhớ**.
3. Chỉ khi cả âm thanh và bản đồ nốt đã xong, nút **Bắt đầu chơi** mới được mở.
4. Chọn độ khó. Bấm bắt đầu; có hai giây đếm vào trước khi âm thanh phát.
5. Dùng D/F/J/K, chuột hoặc cảm ứng để đánh đúng cột tại vạch sáng. Esc tạm dừng. **Dừng lượt** để đổi bài hoặc độ khó.

Không cần nhập BPM hay tự gõ căn nhịp. BPM hiển thị là ước lượng tham khảo; vị trí nốt dùng trực tiếp từng thời điểm khởi âm trong bản thu. Cột được gán theo độ sáng phổ, không phải bản chép chính xác cao độ piano. Chart tự động hiện tạo nốt đơn; demo vẫn có nốt giữ.

**Nguồn phát khi chơi là âm thanh đã tải và phân tích trên máy**, không phải iframe YouTube. Âm thanh được nạp đủ trước khi chơi và dùng chung đồng hồ Web Audio với nốt, nên không lệch vì quảng cáo hoặc tải đệm video trong lượt. Có liên kết mở video gốc bên cạnh tên bài. Nút nhấn chỉ có phản hồi hình ảnh, không phát âm phím.

Lần đầu có thể mất vài phút do tải và khởi tạo thư viện; những lần sau dùng cache. Có thể **Hủy chuẩn bị** hoặc thử lại khi lỗi. Video công khai tối đa **10 phút**, nguồn tải tối đa **100 MB**; không hỗ trợ livestream. Video bị YouTube hạn chế hoặc yêu cầu xác minh có thể không tải được. Tool không tự đọc cookie hoặc đăng nhập tài khoản.

## Giới hạn nhận diện

Dò onset tự động là ước lượng, không bảo đảm mọi nốt đều khớp cảm nhận âm nhạc. Hòa âm dày, tiếng hát, âm ngân dài hoặc bản thu nhiều tạp âm có thể tạo nốt dư/thiếu. Nốt vẫn theo thời điểm thực tế, không bị ép vào một BPM cố định. Tai nghe Bluetooth hoặc thiết bị âm thanh có thể có độ trễ riêng: chỉnh **Bù độ trễ** (dương = nốt đến muộn hơn, âm = sớm hơn).

## Công cụ trên máy

Đã cài thư viện vào `.tools/python/` riêng của dự án: yt-dlp, librosa, imageio-ffmpeg và phụ thuộc. Không thay thế Node/Python hệ thống.
Server dùng Python trong runtime Codex nếu có; có thể đặt biến môi trường `ORBIT_PYTHON` trỏ tới Python 3.12 của bạn.

Nếu chuyển máy hoặc thiếu thư viện, chạy:

```powershell
powershell -File .\Setup-Analysis.ps1
```

Máy cần Python có pip và Node.js. Công cụ dùng Node hiện đang chạy server để xử lý yêu cầu của bộ tải YouTube. Khi YouTube thay đổi cơ chế tải, có thể cần cập nhật yt-dlp và yt-dlp-ejs qua pip.

## Dữ liệu và cấu trúc

- `analysis/prepare.py`: tải âm thanh, chuyển PCM 44.1 kHz, dò onset bằng librosa ở 22.05 kHz / hop 256; ước lượng BPM và độ sáng phổ.
- `analysis/jobs.mjs`: tiến trình nền, tiến độ, cache, hủy và timeout 12 phút.
- `server.mjs`: API localhost và phục vụ audio; kiểm tra Host/Origin, ID và giới hạn body.
- `public/engine.js`: chọn các onset nổi bật theo độ khó, không dịch timestamp và không tự chèn nhịp giả.
- `public/app.js`: chuẩn bị bài, Web Audio, đồng hồ đầu ra, pause/resume, Canvas và chấm điểm.
- `.cache/analysis/<video-id>/audio.wav` và `result.json`: âm thanh cùng bản phân tích. Cache không tự xóa; có thể xóa thư mục của bài khi đã dừng game để lấy lại dung lượng. Các tệp này được gitignore.

## Kiểm tra

```powershell
node --test tests/engine.test.mjs
# Thay đường dẫn Python nếu máy không dùng runtime Codex:
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" tests/test_analysis.py
```

Có kiểm tra timestamp chart với tempo thay đổi, lọc nốt sát nhau, điểm/combo, phân tích âm thanh tổng hợp và từ chối im lặng. Độ chính xác của test tổng hợp không đại diện cho tất cả bản thu thật.

Tài liệu công cụ: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [librosa onset](https://librosa.org/doc/latest/onset.html).
