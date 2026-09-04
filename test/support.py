"""Helpers shared by the prototype tests."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from iobroker.types import now_ms

ENGINE = "system.adapter.python.0"


def script_object(id: str, source: str, *, enabled: bool = True, engine: str = ENGINE) -> dict:
    """A script object shaped the way the javascript adapter's editor writes them."""
    return {
        "_id": id,
        "type": "script",
        "common": {
            "name": id.split(".")[-1],
            "engineType": "Python/py",
            "engine": engine,
            "source": source,
            "enabled": enabled,
            "debug": False,
            "verbose": False,
        },
        "native": {},
    }


async def put_script(client: Any, obj: dict) -> None:
    key = f"cfg.o.{obj['_id']}"
    payload = json.dumps(obj)
    await client.set(key, payload)
    await client.publish(key, payload)


async def drive_state(client: Any, id: str, val: Any, ack: bool = True) -> None:
    """Write and publish a state the way js-controller does."""
    now = now_ms()
    payload = json.dumps(
        {"val": val, "ack": ack, "ts": now, "lc": now, "q": 0, "from": "system.host.test"}
    )
    key = f"io.{id}"
    await client.set(key, payload)
    await client.publish(key, payload)


async def wait_for_state(client: Any, id: str, timeout: float = 10.0) -> dict | None:
    """The state at ``id`` once it exists, retrying -- events are asynchronous."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        raw = await client.get(f"io.{id}")
        if raw:
            return json.loads(raw)
        await asyncio.sleep(0.1)
    return None


async def wait_until(predicate, timeout: float = 10.0) -> bool:
    """Poll ``predicate`` (async) until it is true or the timeout passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(0.1)
    return False
