# Python-Skripte

Ein Skript ist gewöhnliches Python. Es muss nichts importiert werden: `on`, `schedule`, `on_stop`,
`set_state`, `get_state`, `send_to`, `log`, `script_id`, `script_name` und `adapter` stehen beim
Start bereits zur Verfügung.

```python
@on("hue.0.lamp.level")
def dim(event):
    if event.state.val > 80:
        set_state("hue.0.lamp.on", True)
```

Die API ist bewusst, wie die des javascript-Adapters geschnitten -- wer solche Skripte schreibt,
kennt jene meist schon.

## Sync oder async

Handler dürfen `def` oder `async def` sein.

Schreibende Aufrufe liefern einen Task zurück. Genau das lässt beide Schreibweisen funktionieren:
ein einfacher `def`-Handler feuert und vergisst, ein `async def`-Handler kann denselben Aufruf
abwarten.

Lesende Aufrufe müssen abgewartet werden. Ein Skript, das andere States liest, deklariert seinen
Handler also `async def` -- mehr ist die Regel nicht.

```python
@on("hue.0.lamp.on")
async def report(event):
    level = await get_state("hue.0.lamp.level")
    log.info(f"Lampe ist {event.state.val} bei {level.val}")
```

## Ein Prozess

Alle Skripte einer Instanz teilen sich einen Prozess und laufen als asyncio-Tasks. Ein blockierendes
Skript hält die anderen auf -- genau wie ein `while True` im javascript-Adapter dort alles aufhält.
Niemals `time.sleep()` verwenden, sondern `await asyncio.sleep()` in einem `async def`-Handler.

Die Engine benennt den Verursacher: ein Handler, der die Loop länger blockiert als
`Warnen, wenn ein Skript länger blockiert als` Sekunden, wird mit der gerade verarbeiteten
State-Änderung protokolliert.

## on

Ruft einen Handler auf, sobald sich ein passender State ändert.

```python
@on("hue.0.lamp.level")
def eins(event): ...

@on("hue.0.*")            # * ist der einzige Platzhalter
def viele(event): ...

on("hue.0.lamp.on", handler)   # oder ohne Dekorator
```

Der Handler bekommt ein Event-Objekt.

## Das Event-Objekt

Die Namen sind die des `EventObj` aus dem javascript-Adapter, an Python angepasst.

| Eigenschaft                  | Bedeutung                                          |
|------------------------------|----------------------------------------------------|
| `id`                         | Die ID des States                                  |
| `state`                      | Der neue State; Alias von `new_state`              |
| `old_state`                  | Der State davor, oder `None`                       |
| `obj`                        | Das Objekt hinter der ID, `{}` wenn es keines gibt |
| `common`, `native`           | Kurzform für die beiden Abschnitte des Objekts     |
| `name`                       | Der Name des Objekts, in der Sprache des Hosts     |
| `channel_id`, `channel_name` | Der übergeordnete Kanal, oder `None`               |
| `device_id`, `device_name`   | Dessen Elternobjekt, oder `None`                   |
| `enum_ids`, `enum_names`     | Die Aufzählungen der ID, von den Eltern geerbt     |

Alles außer den beiden States wird beim ersten Zugriff aus dem Objektbaum aufgelöst und gemerkt --
ein Handler, der nur `event.state.val` liest, zahlt für nichts davon.

Ein State selbst trägt `val`, `ack`, `ts`, `lc`, `q`, `from_`, `user`, `expire` und `c`. Entscheidend
ist `ack`: `False` ist ein Befehl an ein Gerät, `True` ein bestätigter Messwert. Die beiden zu
verwechseln - baut Rückkopplungen.

## schedule

Ruft einen Handler nach einem Cron-Ausdruck aus fünf Feldern auf -- Minute, Stunde, Tag, Monat,
Wochentag.

```python
@schedule("0 22 * * *")
def nacht():
    set_state("hue.0.lamp.on", False)
```

Jedes Feld nimmt `*`, eine Zahl, eine Liste `1,3,5`, einen Bereich `9-17`, eine Schrittweite `*/15`
oder einen Bereich mit Schrittweite `9-17/2`. Im Wochentagsfeld bedeuten `0` und `7` beide Sonntag.
Ein Sekundenfeld gibt es nicht.

Der Uhr-Knopf in der Werkzeugleiste öffnet einen Assistenten; steht der Cursor in einem vorhandenen
Ausdruck, öffnet er auf diesem und korrigiert ihn an Ort und Stelle.

## on_stop

Läuft, wenn das Skript gestoppt, deaktiviert oder nach einer Änderung neu geladen wird. Damit wird
zurückgenommen, was das Skript eingerichtet hat.

```python
@on_stop
def cleanup():
    log.info("bis später")
```

## set_state, get_state, send_to

```python
set_state("hue.0.lamp.on", True)            # ein Befehl   (ack=False)
set_state("hue.0.lamp.on", True, ack=True)  # ein Messwert (ack=True)

state = await get_state("hue.0.lamp.level")  # braucht async def
send_to("telegram.0", "send", {"text": "hallo"})
```

Alle drei liefern einen Task. Abwarten oder ignorieren -- ein Fehler wird in beiden Fällen dem
Skript zugeschrieben und protokolliert.

## log

`log.debug`, `log.info`, `log.warn` und `log.error`. Jede Zeile trägt den Namen des Skripts und
erscheint im Log-Bereich unter dem Editor, nach Schweregrad eingefärbt.

```python
log.info(f"{event.id} ist jetzt {event.state.val}")
```

`log.debug` erreicht das Log nur, wenn der Log-Level der Instanz es zulässt.

## Editor

|                    |                                                                                   |
|--------------------|-----------------------------------------------------------------------------------|
| `Strg`/`Cmd` + `S` | Speichern                                                                         |
| `Tab`              | Vier Leerzeichen                                                                  |
| `{}`               | Objekt-ID auswählen; steht der Cursor auf einer, öffnet er darauf und ersetzt sie |
| Uhr                | Cron-Assistent, ebenso auf dem Ausdruck unter dem Cursor                          |

Der Reiter öffnet wieder dort, wo er verlassen wurde: dasselbe Skript, dieselben offenen Ordner,
beide Bereiche an ihrer Scroll-Position.
