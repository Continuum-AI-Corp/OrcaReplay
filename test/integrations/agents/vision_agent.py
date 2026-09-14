"""An agent that sends a screenshot, and sends a different one when replayed.

This is the seam the other checks cannot reach. Redaction happens on the way to disk and matching
happens on the way back, and each was defensible alone: the entropy sweep is right that a long
random-looking run is what a leaked key looks like, and the matcher is right to compare what it was
given. Together they made an agent with eyes unreplayable — the sweep shredded the screenshot into
tens of thousands of placeholders, so the recorded bytes were not the sent bytes, and the matcher
then compared a payload no replay could ever reproduce anyway.

So this check drives the whole path with a real image, and `ORCA_CHECK_REPAINT` makes the replay
send a *different* one — which is not a contrived variation but the only thing a browser can do.
Two paintings of one page are never the same bytes.

The PNG is generated rather than committed: it has to be incompressible noise to look like a secret
to the entropy sweep, and a checked-in file of random bytes is a thing reviewers rightly distrust.
"""

import base64
import os
import random
import struct
import zlib

from openai import OpenAI


def png(seed: int, width: int = 16, height: int = 16) -> bytes:
    """A valid PNG of pure noise, which is what a screenshot looks like to an entropy heuristic."""
    rnd = random.Random(seed)
    raw = b"".join(
        b"\x00" + bytes(rnd.randrange(256) for _ in range(width * 3)) for _ in range(height)
    )

    def chunk(tag: bytes, data: bytes) -> bytes:
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        # Stored, not deflated: compressing noise back down would defeat the point of using it.
        + chunk(b"IDAT", zlib.compress(raw, 0))
        + chunk(b"IEND", b"")
    )


# Same size, different pixels — a repaint, not a different page.
payload = base64.b64encode(png(2 if os.environ.get("ORCA_CHECK_REPAINT") else 1)).decode()
print("IMAGE:", payload)

reply = OpenAI().chat.completions.create(
    model="stub-1",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "what is on the screen?"},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{payload}"}},
            ],
        }
    ],
)
print("GOT:", reply.choices[0].message.content)
