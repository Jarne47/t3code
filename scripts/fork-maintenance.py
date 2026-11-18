#!/usr/bin/env python3
"""Verify upstream updates in a disposable worktree and sync the private fork."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import subprocess
import tempfile

NIGHTLY_TAG_PATTERN = "v*-nightly.*"
FAILURE_ALERT = """
set choice to button returned of (display alert "T3 fork update needs attention" message "The scheduled upstream merge stopped. Nothing was pushed." buttons {"Show log", "OK"} default button "Show log")
if choice is "Show log" then do shell script "open -R " & quoted form of (item 1 of argv)
"""


def show_failure_alert(log_path):
    """A banner was missed once; an alert stays on screen until dismissed. Not awaited."""
    subprocess.Popen(["/usr/bin/osascript", "-e", "on run argv", "-e", FAILURE_ALERT, "-e", "end run", str(log_path)],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def maintain(repo, state):
    state.mkdir(parents=True, exist_ok=True)
    with (state / "run.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        started = datetime.datetime.now().astimezone().isoformat()
        result = {"started": started, "status": "running"}
        report = state / "latest.json"
        report.write_text(json.dumps(result, indent=2) + "\n")
        with (state / "latest.log").open("w") as log:
            env = dict(os.environ)
            env.pop("ELECTRON_RUN_AS_NODE", None)
            env.update(GIT_TERMINAL_PROMPT="0", GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=20")

            def run(*args, cwd=repo, capture=False):
                log.write("$ " + " ".join(str(arg) for arg in args) + "\n")
                log.flush()
                completed = subprocess.run(args, cwd=cwd, env=env, check=True, text=True,
                                           stdout=subprocess.PIPE if capture else log, stderr=log)
                return completed.stdout.strip() if capture else None

            try:
                branch = "main"
                personal_ref = f"refs/remotes/origin/{branch}"
                run("git", "fetch", "origin", f"refs/heads/{branch}:{personal_ref}")
                base = run("git", "rev-parse", personal_ref, capture=True)
                # Nightly tags are commits upstream's release workflow already built and packaged.
                run("git", "fetch", "--no-tags", "official", "+refs/tags/v*:refs/tags/v*")
                upstream_tag = run("git", "tag", "--list", NIGHTLY_TAG_PATTERN, "--sort=-v:refname", capture=True).split("\n")[0]
                if not upstream_tag:
                    raise RuntimeError("No upstream nightly tags found.")
                upstream = run("git", "rev-parse", f"{upstream_tag}^{{commit}}", capture=True)
                result.update(base=base, upstream=upstream, upstream_tag=upstream_tag)
                pending = run("git", "rev-list", "--count", f"{base}..{upstream}", capture=True)
                if pending == "0":
                    result.update(status="up-to-date", message="No new upstream commits. Installed app unchanged.")
                else:
                    # This directory belongs only to this invocation, never the user's checkout.
                    with tempfile.TemporaryDirectory(prefix="candidate-", dir=state) as temporary:
                        candidate = Path(temporary) / "repo"
                        run("git", "worktree", "add", "--quiet", "--detach", str(candidate), base)
                        try:
                            run("git", "-c", "core.hooksPath=/dev/null", "merge", "--no-edit", upstream, cwd=candidate)
                            run("vp", "env", "exec", "--node", "24", "--", "vp", "install", "--frozen-lockfile", cwd=candidate)
                            run("bash", "scripts/fork-check.sh", cwd=candidate)
                            run("vp", "env", "exec", "--node", "24", "--", "vp", "run", "--filter", "@t3tools/web", "build", cwd=candidate)
                            if run("git", "status", "--porcelain", cwd=candidate, capture=True):
                                raise RuntimeError("Checks modified tracked files; refusing to push.")
                            revision = run("git", "rev-parse", "HEAD", cwd=candidate, capture=True)
                            # Normal push rejects concurrent, incompatible updates to the fork.
                            run("git", "push", "origin", f"HEAD:refs/heads/{branch}", cwd=candidate)
                            result.update(status="updated", revision=revision, commits=int(pending),
                                          message="Verified updates pushed to private fork. Run fork-update.sh to sync your checkout; desktop build/install is separate.")
                        finally:
                            run("git", "worktree", "remove", "--force", str(candidate))
            except Exception as error:
                result.update(status="failed", message=str(error))
                log.write(f"FAILED: {error}\n")
        result["finished"] = datetime.datetime.now().astimezone().isoformat()
        report.write_text(json.dumps(result, indent=2) + "\n")
        print(json.dumps(result, indent=2))
        if result["status"] in ("updated", "failed") and Path("/usr/bin/osascript").exists():
            try:
                if result["status"] == "updated":
                    subprocess.run(["/usr/bin/osascript", "-e", 'display notification "Updates verified and synced. Desktop installation is ready to prepare." with title "T3 fork maintenance"'], check=False, timeout=15)
                else:
                    show_failure_alert(state / "latest.log")
            except (OSError, subprocess.TimeoutExpired):
                pass  # The durable report remains available when notifications cannot be shown.
        return 1 if result["status"] == "failed" else 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    arguments = parser.parse_args()
    raise SystemExit(maintain(arguments.repo.resolve(), arguments.state.resolve()))
