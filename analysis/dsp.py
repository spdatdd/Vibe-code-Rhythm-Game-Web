"""Phân tích phổ âm và dò điểm khởi âm (onset) theo từng đoạn tiết kiệm RAM."""
import json


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
            mono = signal.mean(axis=1)
            y = mono if wave.samplerate == sr else librosa.resample(mono, orig_sr=wave.samplerate, target_sr=sr)
            peak_level = max(peak_level, float(np.max(np.abs(y))))
            # Bỏ biên có đệm của mỗi đoạn, chỉ giữ vị trí thuộc đoạn chính.
            region = slice(start - first, end - first)
            onset_low = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmin=45, fmax=2500)[region]
            onset_mid = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, fmin=2500, fmax=6000)[region]
            envelope[start:end] = 0.72 * onset_low + 0.28 * onset_mid
            centroid[start:end] = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=hop)[0, region]
        return duration, wave.samplerate, peak_level, envelope, centroid


def _compute_beat_score(seconds, beat_times):
    """Tính độ khớp của thời điểm onset với phách chính / nửa phách (0..1)."""
    import numpy as np

    if len(beat_times) < 2:
        return 0.0
    idx = int(np.searchsorted(beat_times, seconds))
    dist_beat = min(
        abs(seconds - beat_times[idx]) if idx < len(beat_times) else 1e9,
        abs(seconds - beat_times[idx - 1]) if idx > 0 else 1e9,
    )
    if dist_beat <= 0.065:
        return round(float(1.0 - dist_beat / 0.065), 3)
    if 0 < idx < len(beat_times):
        mid = 0.5 * (beat_times[idx - 1] + beat_times[idx])
        dist_half = abs(seconds - mid)
        if dist_half <= 0.065:
            return round(float((1.0 - dist_half / 0.065) * 0.65), 3)
    return 0.0


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
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=envelope, sr=sr, hop_length=hop, units='frames')
    bpm = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 0.0
    beat_times = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop) if len(beat_frames) else np.array([])
    strengths = envelope[peaks] if len(peaks) else np.array([])
    scale = float(np.percentile(strengths, 90)) if len(strengths) else 1.0
    events = []
    for index, frame in enumerate(aligned):
        seconds = float(frame * hop / sr)
        if seconds < .05 or seconds > duration - .15:
            continue
        events.append({'time': round(seconds, 5),
                       'strength': round(min(1.0, float(strengths[index]) / max(scale, .00001)), 4),
                       'brightness': round(float(centroid[min(int(peaks[index]), len(centroid) - 1)]), 2),
                       'beatScore': _compute_beat_score(seconds, beat_times)})
    if len(events) < 8:
        raise ValueError('Không tìm thấy đủ điểm khởi âm rõ ràng. Hãy thử bản nhạc khác.')
    confidence = round(float(np.mean(strengths > max(scale * .25, .00001))), 3)
    return {'duration': round(duration, 5), 'bpm': round(bpm, 2), 'events': events,
            'confidence': confidence, 'method': 'spectral-onset-v2', 'sampleRate': sample_rate}
