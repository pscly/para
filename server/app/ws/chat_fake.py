from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator


async def fake_chat_tokens(text: str) -> AsyncIterator[str]:
    reply = f"AI: {text}"
    for ch in reply:
        await asyncio.sleep(0)
        yield ch
