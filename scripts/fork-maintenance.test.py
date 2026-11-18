import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('maintenance', Path(__file__).with_name('fork-maintenance.py'))
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)
real_run = subprocess.run

class MaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='t3-maintenance-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.state = self.root / 'state'
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.com')
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/fork-check.sh').write_text('test ! -f fail-check\n')
        (self.repo / 'content').write_text('base\n')
        self.commit('base')
        self.base = self.git('rev-parse', 'HEAD')
        for name in ('origin', 'official'):
            self.command('git', 'init', '--bare', str(self.root / name))
            self.git('remote', 'add', name, str(self.root / name))
        self.branch = 'main'
        self.git('branch', 'upstream-fixture')
        self.git('push', 'origin', self.branch)
        self.git('push', 'official', 'main')
        self.nightly = 0
        self.git('tag', '-a', 'v0.0.1-nightly.20260101.0', '-m', 'base nightly')
        self.git('push', 'official', 'v0.0.1-nightly.20260101.0')
        self.git('tag', '-d', 'v0.0.1-nightly.20260101.0')
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        vp = self.binary / 'vp'
        vp.write_text('#!/bin/sh\nexit 0\n')
        vp.chmod(0o755)

    def command(self, *args):
        return real_run(args, cwd=self.repo, check=True, text=True, capture_output=True).stdout.strip()

    def git(self, *args):
        return self.command('git', *args)

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-m', message)

    def advance_upstream(self, fail=False, conflict=False):
        self.git('checkout', 'upstream-fixture')
        (self.repo / ('content' if conflict else 'upstream-change')).write_text('upstream\n')
        if fail:
            (self.repo / 'fail-check').touch()
        self.commit('upstream change')
        self.git('push', 'official', 'HEAD:main')
        self.nightly += 1
        tag = f'v0.0.1-nightly.20260101.{self.nightly}'
        self.git('tag', '-a', tag, '-m', tag)
        self.git('push', 'official', tag)
        self.git('tag', '-d', tag)
        self.git('checkout', self.branch)

    def run_maintenance(self):
        def run(*args, **kwargs):
            if args[0][0] == '/usr/bin/osascript':
                return subprocess.CompletedProcess(args[0], 0)
            return real_run(*args, **kwargs)
        self.alerts = []
        with patch.dict(os.environ, {'PATH': str(self.binary) + ':' + os.environ['PATH']}), patch.object(subprocess, 'run', run), \
                patch.object(maintenance, 'show_failure_alert', self.alerts.append), contextlib.redirect_stdout(io.StringIO()):
            code = maintenance.maintain(self.repo, self.state)
        return code, json.loads((self.state / 'latest.json').read_text())

    def remote_tip(self):
        return self.git('ls-remote', 'origin', 'refs/heads/' + self.branch).split()[0]

    def test_no_updates(self):
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status']), (0, 'up-to-date'))
        self.assertNotIn('vp install', (self.state / 'latest.log').read_text())

    def test_success_preserves_dirty_checkout(self):
        self.advance_upstream()
        (self.repo / 'content').write_text('uncommitted work\n')
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status']), (0, 'updated'))
        self.assertEqual(self.remote_tip(), result['revision'])
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)
        self.assertEqual((self.repo / 'content').read_text(), 'uncommitted work\n')
        self.assertEqual(len(self.git('worktree', 'list').splitlines()), 1)

    def test_merges_newest_nightly_not_main(self):
        self.advance_upstream()
        nightly = self.command('git', '--git-dir', str(self.root / 'official'), 'rev-parse', 'v0.0.1-nightly.20260101.1^{commit}')
        # A main commit without a nightly tag is not merged yet.
        self.git('checkout', 'upstream-fixture')
        (self.repo / 'untagged').write_text('main only\n')
        self.commit('untagged main commit')
        self.git('push', 'official', 'HEAD:main')
        self.git('checkout', self.branch)
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status'], result['upstream']), (0, 'updated', nightly))
        self.assertEqual(result['upstream_tag'], 'v0.0.1-nightly.20260101.1')
        self.assertEqual(self.git('ls-tree', '--name-only', result['revision'], 'untagged'), '')

    def test_failed_check_does_not_push(self):
        self.advance_upstream(fail=True)
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status']), (1, 'failed'))
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.remote_tip(), self.base)
        self.assertEqual(len(self.git('worktree', 'list').splitlines()), 1)

    def test_concurrent_remote_update_is_preserved(self):
        (self.repo / 'fork-only').write_text('new local work\n')
        self.commit('new local work')
        local_tip = self.git('rev-parse', 'HEAD')
        self.advance_upstream()
        # Simulate another process publishing work while candidate checks run.
        (self.binary / 'vp').write_text(
            '#!/bin/sh\ngit -C ' + shlex.quote(str(self.repo)) + ' push origin ' + self.branch + '\n'
        )
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status']), (1, 'failed'))
        self.assertEqual(self.remote_tip(), local_tip)
        self.assertEqual(self.git('rev-parse', 'HEAD'), local_tip)

    def test_conflict_does_not_push_or_touch_checkout(self):
        (self.repo / 'content').write_text('fork change\n')
        self.commit('fork change')
        self.git('push', 'origin', self.branch)
        tip = self.remote_tip()
        self.advance_upstream(conflict=True)
        code, result = self.run_maintenance()
        self.assertEqual((code, result['status']), (1, 'failed'))
        self.assertEqual(self.remote_tip(), tip)
        self.assertEqual(self.git('status', '--porcelain'), '')
        self.assertEqual(len(self.git('worktree', 'list').splitlines()), 1)

unittest.main()
