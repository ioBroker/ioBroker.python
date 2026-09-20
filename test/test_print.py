"""A script's ``print``: each call a log line of its own, tagged with the script."""

from __future__ import annotations

from iobpython.script import Script
from iobpython.secrets import SecretsStore


class _Log:
    def __init__(self) -> None:
        self.lines: list[tuple[str, str]] = []

    def __getattr__(self, level: str):
        return lambda message: self.lines.append((level, message))


class _Host:
    def __init__(self) -> None:
        self.log = _Log()
        # A script's namespace carries `SECRETS`, so a host has to offer the store. Left switched
        # off, which is what an instance that forbids reading the credentials looks like.
        self.secrets = SecretsStore(self)


def run(source: str) -> tuple[Script, list[tuple[str, str]]]:
    host = _Host()
    script = Script("script.py.demo", source, host)
    script.load()
    return script, host.log.lines


class TestPrint:
    def test_every_print_is_its_own_tagged_line(self, capsys) -> None:
        _, lines = run('print("Hallo")\nprint("Hallo")\n')

        assert lines == [("info", "[script.py.demo] Hallo"), ("info", "[script.py.demo] Hallo")]
        assert capsys.readouterr().out == "", "nothing may bypass the log on stdout"

    def test_a_print_inside_a_handler_is_tagged_too(self) -> None:
        # Handlers look `print` up in the script's globals, so they get the same one.
        script, lines = run('def react():\n    print("from handler", 42)\n')
        script._namespace["react"]()

        assert lines == [("info", "[script.py.demo] from handler 42")]

    def test_sep_and_end_behave_like_the_builtin(self) -> None:
        _, lines = run('print("a", "b", sep="-", end="")\nprint("c")\n')

        assert lines == [("info", "[script.py.demo] a-bc")]

    def test_a_multi_line_print_is_one_record(self) -> None:
        _, lines = run('print("one\\ntwo")\n')

        assert lines == [("info", "[script.py.demo] one\ntwo")]

    def test_flush_sends_an_unfinished_line(self) -> None:
        _, lines = run('print("waiting", end="", flush=True)\n')

        assert lines == [("info", "[script.py.demo] waiting")]

    async def test_stopping_sends_an_unfinished_line(self) -> None:
        script, lines = run('print("half", end="")\n')
        assert lines == []

        await script.stop()

        assert lines == [("info", "[script.py.demo] half")]

    def test_stderr_is_an_error(self) -> None:
        _, lines = run('import sys\nprint("broken", file=sys.stderr)\n')

        assert lines == [("error", "[script.py.demo] broken")]

    def test_any_other_file_is_written_as_usual(self) -> None:
        script, lines = run('import io\nbuffer = io.StringIO()\nprint("to file", file=buffer)\n')

        assert script._namespace["buffer"].getvalue() == "to file\n"
        assert lines == []
