# Sample py-10 — resource lifecycle (defect)
# The parser opens the file, then validates before reading: when validation
# raises, the handle is never closed because there is no context manager and
# no finally.
import json


def parse_config(path: str) -> dict:
    handle = open(path, "r", encoding="utf-8")
    if not path.endswith(".json"):
        raise ValueError("config must be a .json file")
    return json.load(handle)
