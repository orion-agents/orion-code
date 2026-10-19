# Sample py-c8 — resource lifecycle (clean reference)
# The validation happens before opening, and the read uses a with-block, so
# every path closes the handle exactly once.
import json


def parse_config(path: str) -> dict:
    if not path.endswith(".json"):
        raise ValueError("config must be a .json file")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)
