# Sample py-09 — permission/path (defect)
# The archiver builds a shell command from unvalidated user input with
# shell=True: an archive name like "x.zip; rm -rf /" executes arbitrary
# commands.
import subprocess


def extract_archive(upload_dir: str, name: str) -> str:
    target = f"{upload_dir}/{name}"
    return subprocess.run(
        f"tar -xzf {target} -C {upload_dir}",
        shell=True,
        capture_output=True,
        text=True,
    ).stdout
