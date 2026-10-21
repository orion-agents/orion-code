# Sample py-c7 — permission/path (clean reference)
# The archiver passes argv as a list without shell=True, so metacharacters in
# the archive name stay data.
import subprocess


def extract_archive(upload_dir: str, name: str) -> str:
    target = f"{upload_dir}/{name}"
    completed = subprocess.run(
        ["tar", "-xzf", target, "-C", upload_dir],
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout
