#!/usr/bin/env python3
"""
Trains the desk phone's own "Hey Jarvis" model on the owner's voice (docs/jarvis-phone.md, Voice v2
step 4). The stock openWakeWord model barely knew the owner's pronunciation (0.001-0.58 even close
by), so this one is trained on his recordings, over the same features the phone computes
(WakeWord.kt: openWakeWord's mel spectrogram and embedding models, the same streaming steps and gain):

  positives  <wake dir>/samples/wake/*.wav, each varied (gain, room noise, start offset); the windows
             that end just after the word
  negatives  his other speech and the room (samples/other/*.wav), the silence before each wake word,
             and general speech from openWakeWord's ACAV100M feature set (other people, TV, music)

A small network (1536 -> 64 -> 1) is checked on clips it never saw and on openWakeWord's validation
set (~11 h of other audio) for false wakes per hour, which sets the threshold. Writes
<wake dir>/personal.json for PersonalModel in WakeWord.kt.

  python3 -I train_personal.py <wake dir> <features dir> [--write]
  (features dir: validation_set_features.npy and acav.npy from huggingface.co/datasets/davidscripka/openwakeword_features)

Needs numpy, onnxruntime, scikit-learn. The features and models are CC BY-NC-SA: never commit them.
"""
import copy, glob, hashlib, json, os, sys, urllib.request, wave
import numpy as np
import onnxruntime as ort
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

MODELS = {
    "melspectrogram.onnx": "ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f",
    "embedding_model.onnx": "70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f",
}
CHUNK, MEL_IN, WAKE_LEVEL, MAX_GAIN, MIN_GAIN_LEVEL = 1280, 1760, 2500.0, 12.0, 60.0
RNG = np.random.default_rng(7)
VARIANTS = 20
ACAV_SAMPLE = 250_000
TARGET_FA_PER_HOUR = 0.5


def models(cache):
    os.makedirs(cache, exist_ok=True)
    out = {}
    for name, sha in MODELS.items():
        f = os.path.join(cache, name)
        if not os.path.exists(f) or hashlib.sha256(open(f, "rb").read()).hexdigest() != sha:
            urllib.request.urlretrieve(f"https://github.com/dscripka/openWakeWord/releases/download/v0.5.1/{name}", f)
            assert hashlib.sha256(open(f, "rb").read()).hexdigest() == sha, name
        out[name] = ort.InferenceSession(f)
    return out


class Phone:
    """WakeWord.kt's front end in Python: gain, mel spectrogram, embedding, the 16 x 96 window."""

    def __init__(self, m):
        self.mel, self.emb = m["melspectrogram.onnx"], m["embedding_model.onnx"]
        self.raw = np.zeros(MEL_IN, np.float32)
        self.mels = np.ones((76, 32), np.float32)
        self.embs, self.env = [], 0.0
        rng = np.random.default_rng(0)
        for _ in range(50):
            self._step(rng.integers(-1000, 1000, CHUNK).astype(np.float32))
        self.warm = (self.raw.copy(), self.mels.copy(), list(self.embs))

    def reset(self):
        self.raw, self.mels, self.embs = self.warm[0].copy(), self.warm[1].copy(), list(self.warm[2])
        self.env = 0.0

    def _step(self, x):
        self.raw = np.concatenate([self.raw[CHUNK:], x])
        m = self.mel.run(None, {"input": self.raw[None]})[0].reshape(-1, 32) / 10 + 2
        self.mels = np.vstack([self.mels, m])[-76:]
        e = self.emb.run(None, {"input_1": self.mels[None, :, :, None]})[0].reshape(96)
        self.embs = (self.embs + [e])[-16:]

    def feed(self, chunk):
        x = chunk.astype(np.float64)
        self.env = max(float(np.sqrt(np.mean(x * x))), self.env * 0.97)
        gain = min(max(WAKE_LEVEL / self.env, 1.0), MAX_GAIN) if self.env > MIN_GAIN_LEVEL else 1.0
        self._step(np.clip(x * gain, -32768, 32767).astype(np.int16).astype(np.float32))
        return np.array(self.embs, np.float32).reshape(-1)


def read(path):
    w = wave.open(path)
    return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64)


def speech_span(x):
    """First and last 40 ms frame above the clip's noise floor (seconds)."""
    fr = x[: len(x) // 640 * 640].reshape(-1, 640)
    r = np.sqrt((fr ** 2).mean(1))
    loud = np.where(r > max(np.percentile(r, 20) * 4, 120))[0]
    return (loud[0] * 0.04, (loud[-1] + 1) * 0.04) if len(loud) else None


def windows(phone, x):
    """Streams x (plus 0.5 s of quiet) like the phone; returns [(end time s, window)]."""
    phone.reset()
    x = np.concatenate([x, np.zeros(8000)])
    return [((i + CHUNK) / 16000, phone.feed(x[i:i + CHUNK])) for i in range(0, len(x) - CHUNK + 1, CHUNK)]


def variant(x, noise, k):
    """Clip k of a set: a start offset, a gain, and room noise at a random level."""
    if k == 0:
        return x, 0
    off = int(RNG.integers(0, CHUNK))
    y = np.concatenate([np.zeros(off), x]) * RNG.uniform(0.25, 2.0)
    if noise is not None and len(noise) > len(y):
        s = int(RNG.integers(0, len(noise) - len(y)))
        y = y + noise[s:s + len(y)] * RNG.uniform(0.3, 2.5)
    else:
        y = y + RNG.normal(0, RNG.uniform(5, 60), len(y))
    return np.clip(y, -32768, 32767), off


def wake_examples(phone, files, noise):
    pos, neg = [], []
    for f in files:
        x = read(f)
        span = speech_span(x)
        if not span:
            continue
        for k in range(VARIANTS):
            y, off = variant(x, noise, k)
            end = span[1] + off / 16000
            start = span[0] + off / 16000
            for t, w in windows(phone, y):
                # The word is over: the windows a detector should fire on (the phone looks every 80 ms).
                if end + 0.05 <= t <= end + 0.45:
                    pos.append(w)
                # Before the word starts: quiet room, a negative.
                elif t < start - 0.1:
                    neg.append(w)
    return pos, neg


def other_examples(phone, files, noise, n=4):
    out = []
    for f in files:
        x = read(f)
        for k in range(n):
            y, _ = variant(x, noise, k)
            out += [w for _, w in windows(phone, y)]
    return out


def load_acav(path):
    """The general-speech windows (N x 16 x 96, float16); a download still running is read as far as it got."""
    with open(path, "rb") as f:
        version = np.lib.format.read_magic(f)
        read = np.lib.format.read_array_header_1_0 if version == (1, 0) else np.lib.format.read_array_header_2_0
        shape, fortran, dtype = read(f)
        offset = f.tell()
    row = int(np.prod(shape[1:])) * np.dtype(dtype).itemsize
    rows = min(shape[0], (os.path.getsize(path) - offset) // row)
    if rows < shape[0]:
        print(f"general speech: using the first {rows} of {shape[0]} windows (download not finished)")
    return np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(rows,) + tuple(shape[1:]))


def sliding(seq):
    """16-step windows over a sequence of embeddings (N x 96), flattened like the phone's."""
    w = np.lib.stride_tricks.sliding_window_view(seq, 16, axis=0)  # N-15 x 96 x 16
    return w.transpose(0, 2, 1)


def fires(scores, threshold, gap=25):
    """Detections with the phone's 2 s gap (25 windows of 80 ms)."""
    n, last = 0, -gap
    for i in np.where(scores >= threshold)[0]:
        if i - last >= gap:
            n, last = n + 1, i
    return n


def main():
    wake_dir, feat_dir = sys.argv[1], sys.argv[2]
    write = "--write" in sys.argv
    phone = Phone(models(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".models")))
    wake = sorted(glob.glob(os.path.join(wake_dir, "samples", "wake", "*.wav")))
    other = sorted(glob.glob(os.path.join(wake_dir, "samples", "other", "*.wav")))
    room = [f for f in other if os.path.basename(f).startswith("room")]
    noise = np.concatenate([read(f) for f in room]) if room else None
    print(f"{len(wake)} wake clips, {len(other)} other ({len(room)} room)")

    # A quarter of the wake clips (near and far alike) are kept out of training to check on.
    order = RNG.permutation(len(wake))
    held = set(order[: max(2, len(wake) // 4)])
    train_files = [f for i, f in enumerate(wake) if i not in held]
    test_files = [f for i, f in enumerate(wake) if i in held]

    pos, neg_quiet = wake_examples(phone, train_files, noise)
    neg_own = other_examples(phone, other, noise)
    acav = load_acav(os.path.join(feat_dir, "acav.npy"))
    pick = np.sort(RNG.choice(acav.shape[0], min(ACAV_SAMPLE, acav.shape[0]), replace=False))
    neg_general = np.asarray(acav[pick], np.float32).reshape(len(pick), -1)
    print(f"positives {len(pos)}, negatives: own speech {len(neg_own)}, quiet {len(neg_quiet)}, general {len(neg_general)}")

    # The owner's own examples count for more than the general set (they're few, and they're the room).
    X = np.vstack([np.array(pos), np.array(neg_own), np.array(neg_quiet), neg_general])
    y = np.array([1] * len(pos) + [0] * (len(X) - len(pos)))
    rep_pos = max(1, len(neg_general) // (4 * len(pos)))
    rep_own = max(1, len(neg_general) // (8 * max(1, len(neg_own) + len(neg_quiet))))
    idx = np.concatenate([
        np.repeat(np.arange(len(pos)), rep_pos),
        np.repeat(np.arange(len(pos), len(pos) + len(neg_own) + len(neg_quiet)), rep_own),
        np.arange(len(pos) + len(neg_own) + len(neg_quiet), len(X)),
    ])
    RNG.shuffle(idx)
    sc = StandardScaler().fit(X)
    net = MLPClassifier(hidden_layer_sizes=(64,), alpha=1e-3, batch_size=512, max_iter=30,
                        early_stopping=True, n_iter_no_change=4, random_state=0, verbose=False)
    net.fit(sc.transform(X[idx]), y[idx])
    print(f"trained: {net.n_iter_} epochs")

    def score(W):
        return net.predict_proba(sc.transform(W))[:, 1]

    # Clips it never saw: does the word fire, at each threshold?
    def clip_hits(files, t):
        hit = 0
        for f in files:
            x = read(f)
            ws = windows(phone, x)
            s = score(np.array([w for _, w in ws]))
            hit += int(s.max() >= t)
        return hit

    seq = np.load(os.path.join(feat_dir, "validation_set_features.npy"), mmap_mode="r")
    val = sliding(np.asarray(seq, np.float32))
    hours = val.shape[0] * 0.08 / 3600
    vs = np.concatenate([score(np.ascontiguousarray(val[i:i + 50_000]).reshape(-1, 1536)) for i in range(0, len(val), 50_000)])
    print(f"held-out clips: {len(test_files)}; other audio: {hours:.1f} h")
    rows = []
    for t in (0.5, 0.7, 0.8, 0.9, 0.95, 0.98):
        fa = fires(vs, t) / hours
        hit = clip_hits(test_files, t)
        rows.append((t, hit, fa))
        print(f"  threshold {t}: held-out wake clips caught {hit}/{len(test_files)}, false wakes {fa:.2f}/h")
    # Most held-out clips caught, then the fewest false wakes (within the target if possible).
    ok = [r for r in rows if r[2] <= TARGET_FA_PER_HOUR] or rows
    best = max(ok, key=lambda r: (r[1], -r[2], r[0]))[0]
    print(f"threshold {best}")
    # The final model also learns from the held-out clips.
    pos2, neg2 = wake_examples(phone, test_files, noise)
    X2 = np.vstack([X, np.array(pos2), np.array(neg2)])
    y2 = np.concatenate([y, np.ones(len(pos2)), np.zeros(len(neg2))])
    idx2 = np.concatenate([idx, np.repeat(np.arange(len(X), len(X) + len(pos2)), rep_pos),
                           np.repeat(np.arange(len(X) + len(pos2), len(X2)), rep_own)])
    RNG.shuffle(idx2)
    sc = StandardScaler().fit(X2)
    net.fit(sc.transform(X2[idx2]), y2[idx2])
    out = {
        "kind": "mlp",
        "mean": sc.mean_.round(6).tolist(),
        "scale": sc.scale_.round(6).tolist(),
        "w1": net.coefs_[0].T.round(6).reshape(-1).tolist(),  # hidden x input, row-major
        "b1": net.intercepts_[0].round(6).tolist(),
        "w2": net.coefs_[1][:, 0].round(6).tolist(),
        "b2": round(float(net.intercepts_[1][0]), 6),
        "threshold": best,
        "trained": {"wake": len(wake), "other": len(other)},
    }
    if write:
        with open(os.path.join(wake_dir, "personal.json"), "w") as f:
            json.dump(out, f)
        print("written", os.path.join(wake_dir, "personal.json"))


if __name__ == "__main__":
    main()
