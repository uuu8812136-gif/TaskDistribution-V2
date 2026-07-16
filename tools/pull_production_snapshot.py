import argparse
import hashlib
import json
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath


EXCLUDED_NAMES = {
    ".env",
    ".git",
    "node_modules",
    "uploads",
    "dist",
    "logs",
    "backups",
}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def should_skip(relative_path):
    return any(part in EXCLUDED_NAMES for part in relative_path.parts)


def download_tree(sftp, remote_root, local_root):
    manifest = []

    def walk(remote_dir, relative_dir):
        for entry in sftp.listdir_attr(remote_dir):
            relative_path = relative_dir / entry.filename
            if should_skip(relative_path):
                continue

            remote_path = str(PurePosixPath(remote_dir) / entry.filename)
            local_path = local_root.joinpath(*relative_path.parts)
            if stat.S_ISDIR(entry.st_mode):
                local_path.mkdir(parents=True, exist_ok=True)
                walk(remote_path, relative_path)
                continue
            if not stat.S_ISREG(entry.st_mode):
                continue

            local_path.parent.mkdir(parents=True, exist_ok=True)
            sftp.get(remote_path, str(local_path))
            manifest.append(
                {
                    "path": relative_path.as_posix(),
                    "bytes": local_path.stat().st_size,
                    "sha256": sha256(local_path),
                }
            )

    walk(remote_root, PurePosixPath())
    return sorted(manifest, key=lambda item: item["path"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--helper-root", required=True)
    parser.add_argument("--remote", default="/srv/task-distribution/current")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise SystemExit(f"Refusing to overwrite non-empty output: {output}")

    helper_root = Path(args.helper_root).resolve()
    sys.path.insert(0, str(helper_root))
    sys.path.insert(0, str(helper_root / "python-deps"))
    import paramiko
    import linux_exec

    key = paramiko.Ed25519Key.from_private_key_file(args.key)
    outer, windows, linux = linux_exec.connect_linux(key)
    try:
        sftp = linux.open_sftp()
        try:
            remote_root = sftp.normalize(args.remote)
            files = download_tree(sftp, remote_root, output)
        finally:
            sftp.close()
    finally:
        linux.close()
        windows.close()
        outer.close()

    manifest = {
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "remoteRoot": remote_root,
        "excludedNames": sorted(EXCLUDED_NAMES),
        "fileCount": len(files),
        "files": files,
    }
    manifest_path = output.parent / "production-snapshot-manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output), "manifest": str(manifest_path), "fileCount": len(files)}))


if __name__ == "__main__":
    main()
