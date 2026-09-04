"""Fixtures for the prototype tests.

Deliberately leaner than the SDK's own suite: one backend (a real Redis), because what is under
test here is the script host, not the database layer -- that is covered thoroughly in
ioBroker/iobroker-python.

Redis defaults to 127.0.0.1:6379 database 15 and is flushed between tests, so it must be dedicated
to the suite. Override with IOB_TEST_REDIS_HOST / _PORT / _DB.
"""

from __future__ import annotations

import asyncio
import contextlib
import os

import pytest
import redis as redis_sync

from iobroker.connection import PROTOCOL_VERSION, DbConfig, connect_async

from iobpython.host import ScriptHost

HOST = os.environ.get("IOB_TEST_REDIS_HOST", "127.0.0.1")
PORT = int(os.environ.get("IOB_TEST_REDIS_PORT", "6379"))
DB = int(os.environ.get("IOB_TEST_REDIS_DB", "15"))


@pytest.fixture(scope="session")
def _config() -> DbConfig:
    probe = redis_sync.Redis(
        host=HOST, port=PORT, db=DB, decode_responses=True, socket_connect_timeout=2
    )
    try:
        probe.ping()
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"no Redis at {HOST}:{PORT} ({exc})")
    finally:
        with contextlib.suppress(Exception):
            probe.close()

    return DbConfig(host=HOST, port=PORT, db=DB, password=None, kind="redis")


@pytest.fixture
async def db(_config: DbConfig):
    """A cleaned database with the protocol version in place, plus a raw client."""
    client = connect_async(_config)
    await client.flushdb()
    await client.set("meta.states.protocolVersion", PROTOCOL_VERSION)
    await client.set("meta.objects.protocolVersion", PROTOCOL_VERSION)
    client.config = _config
    yield client
    await client.aclose()


@pytest.fixture
async def start_host(db, _config: DbConfig, monkeypatch: pytest.MonkeyPatch):
    """Factory that starts a real ScriptHost against the test database."""
    for section in ("STATES", "OBJECTS"):
        monkeypatch.setenv(f"IOB_{section}_HOST", _config.host)
        monkeypatch.setenv(f"IOB_{section}_PORT", str(_config.port))
        monkeypatch.setenv(f"IOB_{section}_DB", str(_config.db))
        monkeypatch.setenv(f"IOB_{section}_TYPE", _config.kind)
        monkeypatch.delenv(f"IOB_{section}_PASS", raising=False)
    for var in ("IOB_CONFIG", "IOB_INSTANCE", "IOB_LOGLEVEL"):
        monkeypatch.delenv(var, raising=False)

    started: list[tuple[ScriptHost, asyncio.Task]] = []

    async def start() -> ScriptHost:
        host = ScriptHost("python", instance=0)
        ready = asyncio.Event()
        original = host.on_ready

        async def on_ready() -> None:
            await original()
            ready.set()

        host.on_ready = on_ready
        task = asyncio.create_task(host._main())
        waiter = asyncio.create_task(ready.wait())
        done, _ = await asyncio.wait(
            {task, waiter}, timeout=20, return_when=asyncio.FIRST_COMPLETED
        )
        if task in done:
            waiter.cancel()
            raise AssertionError(f"host ended during startup: {task.exception()}")
        if not done:
            waiter.cancel()
            task.cancel()
            raise AssertionError("host did not become ready within 20s")

        started.append((host, task))
        return host

    yield start

    for host, task in started:
        host.stop()
        try:
            await asyncio.wait_for(task, timeout=10)
        except Exception:  # noqa: BLE001
            task.cancel()
            with contextlib.suppress(Exception, asyncio.CancelledError):
                await task
