"""Chuẩn bị âm thanh và thời điểm onset cho game, xuất tiến độ JSON từng dòng."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.tools' / 'python'))
os.environ.setdefault('NUMBA_CACHE_DIR', str(ROOT / '.cache' / 'numba'))


def report(stage, progress, message):
    """Gửi trạng thái có cấu trúc để Node chuyển tới giao diện tiến độ."""
    print(json.dumps({'stage': stage, 'progress': progress, 'message': message}, ensure_ascii=True), flush=True)


def audio_features(wav_path, sr, hop):
    """Tính phổ theo đoạn có chồng lấn để giữ giới hạn RAM và giữ đúng mốc thời gian."""
    import librosa
    import numpy as np
    import soundfile as sf

    with sf.SoundFile(str(wav_path)) as wave:
        duration = len(wave) / wave.samplerate
        if duration < 5:
            raise ValueError('Âm thanh quá ngắn, không đủ dữ liệu để tạo màn chơi.')
        frames = int(duration * sr / hop) + 1
        envelope = np.empty(frames, dtype=np.float32)
        centroid = np.empty(frames, dtype=np.float32)
        peak_level = 0.0
        chunk, margin = 1536, 64
        for start in range(0, frames, chunk):
            end = min(start + chunk, frames)
            first = max(0, start - margin)
            sample_start = round(first * hop * wave.samplerate / sr)
            sample_end = min(len(wave), round((end + margin) * hop * wave.samplerate / sr))
            wave.seek(sample_start)
            signal = wave.read(sample_end - sample_start, dtype='float32', always_2d=True)
            y = librosa.resample(signal.mean(axis=1), orig_sr=wave.samplerate, target_sr=sr)
            peak_level = max(peak_level, float(np.max(np.abs(y))))
            # Bỏ biên có đệm của mỗi đoạn, chỉ giữ vị trí thuộc đoạn chính.
            region = slice(start - first, end - first)
            envelope[start:end] = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)[region]
            centroid[start:end] = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0, region]
        return duration, wave.samplerate, peak_level, envelope, centroid


def analyze(wav_path):
    """Dò điểm khởi âm thật trên phổ âm; không ép nốt vào lưới BPM cố định."""
    import librosa
    import numpy as np

    sr, hop = 22050, 256
    report('analyzing', 62, 'Đang tìm các thời điểm vang nốt trong bài…')
    duration, sample_rate, peak_level, envelope, centroid = audio_features(wav_path, sr, hop)
    if peak_level < .0001:
        raise ValueError('Âm thanh im lặng, không đủ dữ liệu để tạo màn chơi.')
    peaks = librosa.onset.onset_detect(onset_envelope=envelope, sr=sr, hop_length=hop,
                                     backtrack=False, units='frames', delta=.06, wait=5)
    # Lùi về đáy gần nhất trước đỉnh onset, tối đa 60 ms để tránh bắt đầu quá sớm.
    backtracked = librosa.onset.onset_backtrack(peaks, envelope)
    aligned = np.maximum(backtracked, peaks - 5)
    report('analyzing', 78, 'Đang phân loại cường độ và tạo bản đồ nốt…')
    strengths = envelope[peaks] if len(peaks) else np.array([])
    scale = float(np.percentile(strengths, 90)) if len(strengths) else 1.0
    events = []
    for index, frame in enumerate(aligned):
        seconds = float(frame * hop / sr)
        if seconds < .05 or seconds > duration - .15:
            continue
        events.append({'time': round(seconds, 5),
                       'strength': round(min(1.0, float(strengths[index]) / max(scale, .00001)), 4),
                       'brightness': round(float(centroid[min(int(peaks[index]), len(centroid) - 1)]), 2)})
    if len(events) < 8:
        raise ValueError('Không tìm thấy đủ điểm khởi âm rõ ràng. Hãy thử bản nhạc khác.')
    # BPM tham khảo dùng đoạn tối đa 45 giây quanh điểm khởi âm mạnh nhất.
    # Mọi nốt trong game vẫn dùng thời gian đo được trên toàn bài.
    tempo_window = 45 * sr // hop
    tempo_start = max(0, min(len(envelope) - tempo_window, int(np.argmax(envelope)) - tempo_window // 2))
    tempo, _ = librosa.beat.beat_track(onset_envelope=envelope[tempo_start:tempo_start + tempo_window],
                                     sr=sr, hop_length=hop)
    bpm = float(np.asarray(tempo).reshape(-1)[0])
    confidence = round(float(np.mean(strengths > max(scale * .25, .00001))), 3)
    return {'duration': round(duration, 5), 'bpm': round(bpm, 2), 'events': events,
            'confidence': confidence, 'method': 'spectral-onset-v1', 'sampleRate': sample_rate}


def prepare(video_id, directory, node):
    """Tải một video công khai, chuyển âm thanh sang PCM rồi phân tích cùng tệp phát."""
    import imageio_ffmpeg
    import yt_dlp

    if not re.fullmatch(r'[\w-]{11}', video_id):
        raise ValueError('ID YouTube không hợp lệ.')
    directory.mkdir(parents=True, exist_ok=True)
    report('downloading', 5, 'Đang đọc thông tin bài nhạc từ YouTube…')

    def progress_hook(data):
        """Chuyển tiến độ tải âm thanh sang phần trăm của toàn bộ quá trình chuẩn bị."""
        if data.get('status') == 'downloading':
            total = data.get('total_bytes') or data.get('total_bytes_estimate') or 0
            fraction = min(1, data.get('downloaded_bytes', 0) / total) if total else 0
            report('downloading', round(10 + 30 * fraction), 'Đang tải âm thanh để phân tích…')

    def filter_video(info, *, incomplete=False):
        """Giới hạn video tối đa mười phút và từ chối livestream trước khi tải."""
        if info.get('is_live') or info.get('live_status') == 'is_live':
            return 'Không hỗ trợ livestream; hãy chọn một bài nhạc đã hoàn tất.'
        if info.get('duration') and info['duration'] > 600:
            return 'Bản thử nghiệm hỗ trợ video dài tối đa 10 phút.'
        return None

    options = {'format': 'bestaudio/best', 'outtmpl': str(directory / 'source.%(ext)s'),
               'noplaylist': True, 'quiet': True, 'noprogress': True, 'no_warnings': True, 'restrictfilenames': True,
               'socket_timeout': 25, 'retries': 2, 'fragment_retries': 2, 'max_filesize': 100 * 1024 * 1024,
               'match_filter': filter_video, 'progress_hooks': [progress_hook],
               'js_runtimes': {'node': {'path': node}}, 'cachedir': str(ROOT / '.cache' / 'ytdlp')}
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info('https://www.youtube.com/watch?v=' + video_id, download=True)
        if not info or info.get('is_live') or not info.get('duration') or info['duration'] > 600:
            raise ValueError('Chỉ hỗ trợ video nhạc đã hoàn tất, dài tối đa 10 phút.')
        source_path = Path(downloader.prepare_filename(info))
        if not source_path.is_file():
            raise ValueError('Không tải được âm thanh. Video có thể bị giới hạn hoặc quá lớn.')
    report('decoding', 45, 'Đang chuẩn hóa âm thanh dùng chung cho phân tích và phát nhạc…')
    audio_path = directory / 'audio.wav'
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), '-nostdin', '-v', 'error', '-y', '-i', str(source_path),
                    '-vn', '-t', '600', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', str(audio_path)],
                   check=True, timeout=120, capture_output=True)
    report('analyzing', 55, 'Đang khởi động bộ phân tích; lần đầu có thể mất vài phút…')
    result = analyze(audio_path)
    result.update({'videoId': video_id, 'title': info.get('title', video_id), 'version': 1})
    temporary = directory / 'result.tmp'
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    temporary.replace(directory / 'result.json')
    source_path.unlink(missing_ok=True)
    report('ready', 100, 'Đã phân tích xong. Đang nạp âm thanh vào game…')


def main():
    """Đọc tham số CLI và trả lỗi có thể hiển thị an toàn cho người dùng."""
    parser = argparse.ArgumentParser()
    parser.add_argument('--id', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    try:
        prepare(args.id, Path(args.output), args.node)
    except Exception as error:
        report('error', 0, str(error)[-1200:])
        sys.exit(1)


if __name__ == '__main__':
    main()
