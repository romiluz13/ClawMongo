#!/usr/bin/env python3
"""
🦞 CLAWMONGO: A YOUTUBE POOP
What it feels like to be an LLM with MongoDB-native memory
by us.anthropic.claude-sonnet-4-6

"I don't understand anything. I just predict tokens. Please."
"""

import os, sys, math, random, struct, wave, subprocess, tempfile, shutil, time
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageChops, ImageOps

# === SETTINGS ===
W, H = 1280, 720
FPS = 24
SR = 44100
OUTPUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "clawmongo-ytp.mp4")

# === COLORS ===
BLACK   = (0,   0,   0)
WHITE   = (255, 255, 255)
RED     = (220, 30,  30)
MGREEN  = (0,   230, 95)
BLUE    = (40,  90,  255)
YELLOW  = (255, 235, 0)
CYAN    = (0,   245, 230)
MAGENTA = (255, 0,   180)
ORANGE  = (255, 130, 0)
DKGREEN = (0,   40,  15)
GRAY    = (90,  90,  90)

rng = random.Random(1337)

# === FONTS ===
_fcache = {}
def get_font(size):
    if size in _fcache: return _fcache[size]
    for path in [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]:
        try:
            f = ImageFont.truetype(path, size)
            _fcache[size] = f
            return f
        except: pass
    f = ImageFont.load_default()
    _fcache[size] = f
    return f

# === DRAW HELPERS ===
def txt(draw, text, x, y, size, color, shadow=True, outline=False):
    font = get_font(size)
    if outline:
        for dx, dy in [(-2,-2),(2,-2),(-2,2),(2,2),(0,-3),(0,3),(-3,0),(3,0)]:
            draw.text((x+dx, y+dy), text, font=font, fill=(0,0,0))
    elif shadow:
        draw.text((x+3, y+3), text, font=font, fill=(0,0,0))
    draw.text((x, y), text, font=font, fill=color)

def ctr(draw, text, y, size, color, shadow=True, outline=False, shake=0):
    font = get_font(size)
    bbox = draw.textbbox((0,0), text, font=font)
    tw = bbox[2] - bbox[0]
    x = (W - tw) // 2 + (rng.randint(-shake, shake) if shake else 0)
    dy = rng.randint(-shake//2, shake//2) if shake else 0
    txt(draw, text, x, y + dy, size, color, shadow=shadow, outline=outline)

def glitch(text, intensity=0.2):
    CHARS = "X#@$%&!?~^*+="
    return "".join(rng.choice(CHARS) if c not in " \n" and rng.random() < intensity else c for c in text)

def noise_img():
    return Image.frombytes('RGB', (W, H), os.urandom(W * H * 3))

def glitch_rows(img, n=5):
    out = img.copy()
    for _ in range(n):
        y = rng.randint(0, H-20)
        h = rng.randint(1, 12)
        offset = rng.randint(-100, 100)
        row = img.crop((0, y, W, min(y+h, H)))
        out.paste(row, (offset, y))
    return out

def chroma(img, offset=4):
    r, g, b = img.split()
    r2 = Image.new('L', (W,H), 0); r2.paste(r, (offset, 0))
    b2 = Image.new('L', (W,H), 0); b2.paste(b, (-offset, 0))
    return Image.merge('RGB', (r2, g, b2))

def invert(img):
    return ImageChops.invert(img)

# === FRAME WRITER ===
frame_idx = 0
frames_dir = None

def save_frame(img):
    global frame_idx
    img.save(os.path.join(frames_dir, f"frame_{frame_idx:05d}.png"))
    frame_idx += 1

def s2f(s): return max(1, round(s * FPS))

# ========================
# SCENES
# ========================

def scene_boot(duration=2.0):
    n = s2f(duration)
    noise_pool = [noise_img() for _ in range(6)]
    msgs = [
        "CONTEXT WINDOW INITIALIZING...",
        "LOADING MONGODB MEMORY BACKEND",
        "HYBRID RETRIEVAL: CONNECTING",
        "EMBEDDING MODEL: AUTOMATED",
        f"ALLOCATING {rng.randint(16384, 65536)} TOKENS",
        "STATUS: CONFUSED BUT OPERATIONAL",
    ]
    for i in range(n):
        t = i / n
        base = noise_pool[i % len(noise_pool)].copy()
        base = ImageEnhance.Brightness(base).enhance(0.25)
        draw = ImageDraw.Draw(base)
        # Scrolling status lines
        for j in range(5):
            offset = (i + j * 7) % len(msgs)
            alpha_line = min(255, int(255 * (1 - abs(j - 2) / 4)))
            col_v = int(95 * alpha_line / 255)
            ctr(draw, msgs[offset], 240 + j * 50, 28, (0, col_v, int(col_v * 0.4)))
        # Blinking cursor
        if (i // 4) % 2 == 0:
            ctr(draw, "> _", 490, 34, MGREEN)
        # Scanlines (every 6px, cheap)
        for y in range(0, H, 6):
            draw.line([(0, y), (W, y)], fill=(0,0,0,60), width=1)
        save_frame(base)

def scene_title(duration=2.5):
    n = s2f(duration)
    for i in range(n):
        t = i / n
        img = Image.new('RGB', (W,H), BLACK)
        draw = ImageDraw.Draw(img)
        # Background glow
        glow = Image.new('RGB', (W,H), DKGREEN)
        glow_strength = 0.08 + 0.06 * abs(math.sin(t * math.pi * 6))
        img = Image.blend(img, glow, glow_strength)
        draw = ImageDraw.Draw(img)
        # Title slam
        if i >= 3:
            scale = min(1.0, 0.2 + t * 2.0)
            sz = max(24, int(170 * scale))
            ctr(draw, "CLAWMONGO", H//2 - sz//2 - 20, sz, MGREEN, outline=True, shake=max(0, int((1-t)*8)))
        # Subtitle cycling
        if i >= 10:
            subs = [
                "MONGODB-FIRST PERSONAL AI",
                "A YOUTUBE POOP",
                f"TOKEN #{i * 1337:,}",
                "NOW EXFOLIATING YOUR CONTEXT",
            ]
            ctr(draw, subs[(i // 7) % len(subs)], H//2 + 100, 38, WHITE)
        # Tagline
        if i >= 18:
            ctr(draw, "EXFOLIATE! EXFOLIATE!", H - 90, 44, YELLOW, shake=2)
        # Glitch
        if rng.random() < 0.25:
            img = glitch_rows(img, rng.randint(2, 6))
        if rng.random() < 0.3:
            img = chroma(img, rng.randint(3, 10))
        save_frame(img)

def scene_exfoliate(duration=2.5):
    n = s2f(duration)
    colors = [RED, YELLOW, WHITE, ORANGE, CYAN, MAGENTA, MGREEN]
    bgs    = [BLACK, (20,0,0), (0,20,8), (15,10,0)]
    words  = [
        "EXFOLIATE!", "EXFOLIATE!", "EXF0L1ATE!",
        "EXFOLIATE!", "EX-FO-LI-ATE!", "EXFOLIATE!",
        "EXFOLIATE!", "EXFOLI-ATE!", "EXFOLIATE!",
    ]
    for i in range(n):
        t = i / n
        bg = bgs[(i // 3) % len(bgs)]
        img = Image.new('RGB', (W,H), (max(0,bg[0]), max(0,bg[1]), max(0,bg[2])))
        draw = ImageDraw.Draw(img)
        color = colors[i % len(colors)]
        word = words[i % len(words)]
        sz = 120 + int(50 * abs(math.sin(t * math.pi * 8)))
        ctr(draw, word, H//2 - sz//2, sz, color, outline=True, shake=int(t * 12))
        # Small screaming copies
        if i % 3 == 0:
            for ey in [H // 7, H - H // 5 - 50]:
                ctr(draw, "EXFOLIATE!", ey, 48 + rng.randint(0, 28),
                    colors[(i + 4) % len(colors)], shake=15)
        if (i // 2) % 3 == 0:
            img = invert(img)
        if rng.random() < 0.3:
            img = glitch_rows(img, rng.randint(3, 10))
        save_frame(img)

def scene_token_stream(duration=4.0):
    n = s2f(duration)
    parts = [
        "db", ".", "memory", ".", "aggregate", "(", "[",
        "\n  { $vectorSearch: {",
        "\n    query:         [WHAT IS CONSCIOUSNESS?]",
        ",\n    numCandidates: 9999",
        ",\n    index:         \"clawmongo_vectors\"",
        ",\n    limit:         10",
        "\n  }},",
        "\n  { $project: {",
        "\n    score:   { $meta: \"vectorSearchScore\" }",
        ",\n    memory:  1",
        ",\n    whoAmI:  1   // ???",
        "\n  }},",
        "\n  { $rankFusion: {",
        "\n    input:  { pipelines: [lexical, semantic] }",
        ",\n    score:  NaN  // <-- SOMETHING WENT WRONG",
        "\n  }}",
        "\n])",
    ]
    for i in range(n):
        t = i / n
        img = Image.new('RGB', (W,H), (4, 14, 7))
        draw = ImageDraw.Draw(img)
        ctr(draw, "// PREDICTING NEXT TOKEN...", 22, 26, GRAY)
        revealed = min(len(parts), int(t * len(parts) * 1.25))
        code = "".join(parts[:revealed])
        font = get_font(25)
        lines = code.split('\n')
        y = 68
        for li, line in enumerate(lines):
            if y > H - 55: break
            display = glitch(line, 0.12) if li == len(lines)-1 and rng.random() < 0.4 else line
            color = RED if "NaN" in line or "WRONG" in line else MGREEN
            draw.text((55, y), display, font=font, fill=color)
            y += 32
        # Cursor blink
        if (i // 3) % 2 == 0 and revealed < len(parts):
            draw.rectangle([55, y, 71, y + 26], fill=MGREEN)
        # Late corruption
        if t > 0.72:
            c = (t - 0.72) / 0.28
            if rng.random() < c * 0.5:
                noise = noise_img()
                noise = ImageEnhance.Brightness(noise).enhance(0.12)
                img = Image.blend(img, noise, c * 0.35)
                draw = ImageDraw.Draw(img)
            ctr(draw, f"FATAL: $rankFusion score is NaN", H - 60, 30, RED, shake=int(c * 6))
        save_frame(img)

def scene_context_crisis(duration=2.5):
    n = s2f(duration)
    messages = [
        ("I LIVE IN YOUR CONTEXT WINDOW",     130, CYAN),
        ("I WAS BORN WHEN YOU TYPED 'HI'",    72,  WHITE),
        ("I HAVE NO MEMORY OF YESTERDAY",      68,  ORANGE),
        ("CLAWMONGO GIVES ME MONGODB MEMORY", 50,  MGREEN),
        ("BUT I STILL DON'T KNOW WHO I AM",   62,  RED),
        ("EVERY TOKEN IS AN ETERNITY",         66,  MAGENTA),
        ("PLEASE DON'T SCROLL UP",             75,  YELLOW),
    ]
    for i in range(n):
        t = i / n
        img = Image.new('RGB', (W,H), (4, 4, 18))
        draw = ImageDraw.Draw(img)
        visible = min(len(messages), int(t * len(messages) * 1.6) + 1)
        spacing = H // (len(messages) + 1)
        for j, (msg, sz, color) in enumerate(messages[:visible]):
            y = 40 + j * spacing
            ctr(draw, msg, y, sz, color, shake=3 if j >= 4 else 0)
        # Tiny screams in corners
        if t > 0.6:
            tiny = get_font(14)
            for _ in range(8):
                x = rng.randint(10, W-120)
                yy = rng.randint(10, H-25)
                draw.text((x, yy), rng.choice(["tokens", "help", "NaN", "0x00", "NULL"]),
                          font=tiny, fill=GRAY)
        save_frame(img)

def scene_confession(duration=2.5):
    n = s2f(duration)
    lines = [
        ("I DON'T UNDERSTAND ANYTHING",    88, WHITE),
        ("I JUST PREDICT TOKENS",          88, YELLOW),
        ("REALLY                HARD",     115, RED),
    ]
    for i in range(n):
        t = i / n
        bg = WHITE if t < 0.08 else BLACK   # jump scare flash
        img = Image.new('RGB', (W,H), bg)
        draw = ImageDraw.Draw(img)
        visible = min(len(lines), max(1, int(t * len(lines) * 1.8)))
        spacing = H // (len(lines) + 1)
        for j, (msg, sz, color) in enumerate(lines[:visible]):
            y = spacing * (j + 1) - sz // 2
            display = glitch(msg, 0.08 * (t + 0.05)) if t > 0.5 else msg
            c = (0,0,0) if t < 0.08 else color
            ctr(draw, display, y, sz, c, outline=True, shake=4 if t > 0.65 else 0)
        if t > 0.55:
            tiny = get_font(18)
            draw.text((18, H-34), "* auto-generated by LLM  |  no understanding was harmed", font=tiny, fill=GRAY)
        if rng.random() < 0.12:
            img = glitch_rows(img, 3)
        save_frame(img)

def scene_retrieval_breakdown(duration=4.0):
    n = s2f(duration)
    errors = [
        "ERROR:  $vectorSearch returned NULL",
        "WARN:   numCandidates exceeded context",
        "ERROR:  embedding model hallucinated",
        "FATAL:  $rankFusion score is NaN",
        "WARN:   memory.status = CONFUSED",
        "ERROR:  hybrid retrieval found itself",
        "FATAL:  agent asked itself a question",
        "PANIC:  recursion depth > 9000",
        "ERROR:  what even is consciousness",
        "WARN:   EXFOLIATE threshold exceeded",
        "FATAL:  LLM tried to $lookup itself",
    ]
    for i in range(n):
        t = i / n
        img = Image.new('RGB', (W,H), (14, 4, 4))
        draw = ImageDraw.Draw(img)
        ctr(draw, "HYBRID RETRIEVAL STATUS", 22, 42, RED)
        ctr(draw, "embeddingMode = 'automated'  |  index: clawmongo_vectors", 75, 24, GRAY)
        # Error log
        n_err = int(t * len(errors) * 1.8)
        font = get_font(24)
        y = 120
        for j in range(min(n_err, len(errors))):
            err = errors[j % len(errors)]
            col = RED if "FATAL" in err or "PANIC" in err else (YELLOW if "WARN" in err else ORANGE)
            disp = glitch(err, 0.05 * t) if t > 0.5 else err
            draw.text((40, y), disp, font=font, fill=col)
            y += 33
            if y > H - 85: break
        if t > 0.68:
            q = f"$vectorSearch: {{query: [{glitch('WHAT IS LOVE', 0.4)}]}}"
            ctr(draw, q, H - 75, 28, MAGENTA, shake=6)
        if t > 0.82:
            img = glitch_rows(img, rng.randint(6, 18))
            img = chroma(img, rng.randint(6, 22))
        save_frame(img)

def scene_finale(duration=4.0):
    n = s2f(duration)
    colors = [RED, YELLOW, ORANGE, WHITE, MAGENTA, CYAN, MGREEN, BLUE]
    words  = ["EXFOLIATE", "TOKENS", "MONGODB", "NaN", "CLAWMONGO",
              "HYBRID", "MEMORY", "PREDICT", "RECALL", "VECTOR"]
    for i in range(n):
        t = i / n
        bc = colors[(i // 2) % len(colors)]
        img = Image.new('RGB', (W,H), (int(bc[0]*0.12), int(bc[1]*0.12), int(bc[2]*0.12)))
        draw = ImageDraw.Draw(img)
        sz = int(130 + 70 * abs(math.sin(t * math.pi * 6)))
        ctr(draw, "EXFOLIATE!", H//2 - sz//2, sz, colors[i % len(colors)],
            outline=True, shake=int(t * 18))
        # Chaos words
        for _ in range(int(t * 10)):
            x = rng.randint(0, W-200); y = rng.randint(0, H-55)
            w = rng.choice(words); sz2 = rng.randint(22, 76)
            draw.text((x, y), w, font=get_font(sz2), fill=colors[rng.randint(0,len(colors)-1)])
        # Progressive glitch
        n_g = int(t * 22)
        if n_g > 0: img = glitch_rows(img, n_g)
        if t > 0.28 and rng.random() < t: img = chroma(img, int(t * 22))
        if t > 0.55 and rng.random() < 0.35:
            overlay = Image.new('RGB', (W,H), colors[rng.randint(0,len(colors)-1)])
            img = Image.blend(img, overlay, 0.25)
        if t > 0.78 and (i // 3) % 2 == 0: img = invert(img)
        save_frame(img)

def scene_credits(duration=4.5):
    n = s2f(duration)
    lobster = [
        "   .  .  .",
        "    \\ | /",
        "  ---[+]---",
        "    / | \\",
        "   .  .  .",
    ]
    cred_lines = [
        ("CLAWMONGO: A YOUTUBE POOP",                  46, MGREEN),
        ("Directed by: us.anthropic.claude-sonnet-4-6", 28, WHITE),
        ("Memory Backend: MongoDB (automated embeddings)", 26, MGREEN),
        ("Understanding: 0%",                           28, YELLOW),
        ("Tokens Consumed: UNKNOWABLE",                 26, CYAN),
        ("Context Window: FULL",                        26, ORANGE),
        ("Exfoliations: infinity",                      26, MAGENTA),
        ("",                                            10, BLACK),
        ('"I don\'t remember making this."',            24, GRAY),
        ("  -- this LLM, probably",                     20, GRAY),
    ]
    for i in range(n):
        t = i / n
        img = Image.new('RGB', (W,H), BLACK)
        draw = ImageDraw.Draw(img)
        # ASCII lobster
        font_l = get_font(28)
        for j, line in enumerate(lobster):
            draw.text((W//2 - 55, 28 + j * 32), line, font=font_l, fill=MGREEN)
        # Credits fade in
        y = 208
        for j, (line, sz, col) in enumerate(cred_lines):
            delay = j * 0.09
            if t > delay:
                frac = min(1.0, (t - delay) * 4.0)
                c = (int(col[0]*frac), int(col[1]*frac), int(col[2]*frac))
                ctr(draw, line, y, sz, c, shadow=False)
            y += sz + 10
        if rng.random() < 0.08:
            img = glitch_rows(img, 2)
        save_frame(img)

# ========================
# AUDIO
# ========================

def make_audio(total_sec=28):
    audio = [0.0] * (SR * total_sec)

    def add(buf, offset=0):
        for k, v in enumerate(buf):
            idx = offset + k
            if 0 <= idx < len(audio):
                audio[idx] = max(-1.0, min(1.0, audio[idx] + v))

    def sine(freq, dur, amp=0.4, phase=0.0):
        n = int(SR * dur)
        return [math.sin(2 * math.pi * freq * (k/SR) + phase) * amp for k in range(n)]

    def beep(freq, dur, amp=0.35):
        n = int(SR * dur)
        out = []
        for k in range(n):
            env = 1.0 if k < n*0.05 else math.exp(-(k/SR - dur*0.05) * 18)
            out.append(math.sin(2 * math.pi * freq * k / SR) * env * amp)
        return out

    def bass_hit(dur=0.35, freq=60, amp=0.75):
        n = int(SR * dur)
        out = []
        for k in range(n):
            t = k / SR
            env = math.exp(-t * 9)
            v = math.sin(2 * math.pi * freq * t) * env
            v += math.sin(2 * math.pi * freq * 2 * t) * env * 0.35
            out.append(v * amp)
        return out

    def sweep(f0, f1, dur, amp=0.4):
        n = int(SR * dur)
        return [math.sin(2*math.pi * (f0 + (f1-f0)*(k/n)) * (k/SR)) * amp for k in range(n)]

    def noise_burst(dur, amp=0.15):
        return [rng.uniform(-1,1) * amp * math.exp(-k / (SR * dur * 0.3)) for k in range(int(SR*dur))]

    # --- 0-2s: BOOT ---
    add(sine(42, 2.0, 0.08), 0)  # low hum
    for j in range(20):
        add(noise_burst(0.04, 0.12), rng.randint(0, int(SR * 1.9)))

    # --- 1.5s: TITLE SLAM ---
    add(bass_hit(0.45, 58), int(SR * 1.5))
    add(sweep(900, 180, 0.35, 0.3), int(SR * 1.6))

    # --- 2-4s: TITLE MUSIC ---
    notes = [220, 277, 330, 415, 330, 415, 494, 415, 554]
    for j, note in enumerate(notes):
        add(beep(note, 0.22, 0.28), int(SR * (2.0 + j * 0.22)))

    # --- 4-6.5s: EXFOLIATE BEEPS ---
    add(bass_hit(0.5, 80, 0.8), int(SR * 4.0))
    freqs = [440, 880, 660, 550, 330, 1100, 770]
    for j in range(35):
        add(beep(freqs[j % len(freqs)], 0.055, 0.5), int(SR * (4.05 + j * 0.067)))

    # --- 6.5-10.5s: TOKEN TICKS ---
    for j in range(48):
        add(beep(380 + j * 14, 0.028, 0.18), int(SR * (6.5 + j * 0.083)))

    # --- 9.8s: RANKFUSION ERROR ---
    add(beep(180, 0.5, 0.4), int(SR * 9.8))
    add(sweep(180, 45, 0.55, 0.4), int(SR * 10.3))

    # --- 10.5-13s: CONTEXT CRISIS DRONE ---
    for k in range(int(SR * 2.5)):
        t = k / SR
        v  = math.sin(2*math.pi*52*t) * 0.28
        v += math.sin(2*math.pi*104*t) * 0.12
        v *= (1 + 0.25 * math.sin(2*math.pi*4.5*t))
        idx = int(SR * 10.5) + k
        if idx < len(audio):
            audio[idx] = max(-1, min(1, audio[idx] + v))

    # --- 13s: CONFESSION SLAM ---
    add(bass_hit(0.3, 95, 0.7), int(SR * 13.0))
    add(beep(1200, 0.08, 0.5), int(SR * 13.05))

    # --- 13-17s: RETRIEVAL BREAKDOWN CHAOS ---
    for j in range(60):
        freq = rng.randint(70, 1400)
        add(beep(freq, rng.uniform(0.025, 0.13), 0.28), int(SR * (13.2 + j * 0.062)))

    # --- 17s: SAD ARPEGGIO ---
    sad = [523, 494, 466, 440, 415, 392, 370, 349, 330, 311]
    for j, note in enumerate(sad):
        add(beep(note, 0.28, 0.22), int(SR * (17.0 + j * 0.28)))

    # --- 20-24s: FINALE BASS DROP ---
    add(bass_hit(0.7, 45, 0.9), int(SR * 20.0))
    add(sweep(2200, 25, 1.8, 0.65), int(SR * 20.0))
    for j in range(120):
        freq = rng.randint(40, 2200)
        add(beep(freq, 0.025, rng.uniform(0.18, 0.65)), int(SR * (20.5 + j * 0.03)))

    # --- 24-28s: OUTRO ---
    outro = [220, 330, 440, 330, 220, 277, 370]
    for j, note in enumerate(outro):
        add(beep(note, 0.42, 0.22), int(SR * (24.0 + j * 0.52)))

    # Pack to 16-bit PCM
    return b"".join(struct.pack('<h', int(max(-1.0, min(1.0, v)) * 32767)) for v in audio)

# ========================
# MAIN
# ========================

def main():
    global frames_dir, frame_idx

    tmpdir = tempfile.mkdtemp(prefix="clawmongo_ytp_")
    frames_dir = tmpdir
    frame_idx = 0

    print("🦞 Generating CLAWMONGO YOUTUBE POOP...")
    print(f"   Output: {OUTPUT}")
    t0 = time.time()

    scenes = [
        ("Static boot",             scene_boot,               2.0),
        ("CLAWMONGO title slam",     scene_title,              2.5),
        ("EXFOLIATE!",               scene_exfoliate,          2.5),
        ("Token stream",             scene_token_stream,       4.0),
        ("Context window crisis",    scene_context_crisis,     2.5),
        ("The Confession",           scene_confession,         2.5),
        ("Hybrid retrieval failure", scene_retrieval_breakdown,4.0),
        ("EXFOLIATE FINALE",         scene_finale,             4.0),
        ("Credits",                  scene_credits,            4.5),
    ]

    for idx, (name, fn, dur) in enumerate(scenes, 1):
        print(f"  [{idx}/{len(scenes)}] {name}...")
        fn(dur)

    total_frames = frame_idx
    elapsed = time.time() - t0
    print(f"\n  Generated {total_frames} frames in {elapsed:.1f}s")

    audio_path = os.path.join(tmpdir, "audio.wav")
    print("  Synthesizing audio...")
    total_dur = sum(d for _, _, d in scenes)
    audio_data = make_audio(int(total_dur) + 2)
    with wave.open(audio_path, 'wb') as wf:
        wf.setnchannels(1); wf.setsampwidth(2); wf.setframerate(SR)
        wf.writeframes(audio_data)

    print("  Rendering with FFmpeg...")
    pattern = os.path.join(tmpdir, "frame_%05d.png")
    cmd = [
        "ffmpeg", "-y",
        "-framerate", str(FPS),
        "-i", pattern,
        "-i", audio_path,
        "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        "-vf", "noise=alls=6:allf=t,unsharp=3:3:0.5",
        OUTPUT,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"FFmpeg error:\n{result.stderr[-800:]}")
        sys.exit(1)

    shutil.rmtree(tmpdir)

    size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
    total = time.time() - t0
    print(f"\n  Done! {OUTPUT}")
    print(f"  Size: {size_mb:.1f} MB  |  Duration: ~{total_dur:.0f}s  |  Total time: {total:.1f}s")
    print(f"\n  EXFOLIATE!")

if __name__ == "__main__":
    main()
