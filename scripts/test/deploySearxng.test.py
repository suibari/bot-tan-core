import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class DeployTests(unittest.TestCase):
    def run_deploy(self, diff="", failure="", missing_env=False, needs_sudo=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scripts").mkdir()
            (root / "searxng").mkdir()
            (root / "bin").mkdir()
            if not missing_env:
                (root / "searxng/.env").touch()
            shutil.copy(ROOT / "scripts/deploy-searxng.sh", root / "scripts")
            script = (ROOT / "scripts/deploy.sh").read_text().replace(
                'PROJECT_ROOT="/home/suibari/work/bsky-affirmative-bot"',
                f'PROJECT_ROOT="{root}"',
            )
            (root / "scripts/deploy.sh").write_text(script)
            stub = '''
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps([name, *args]) + '\\n')
if name == 'git':
    if args[:1] == ['rev-parse']: print('test-head')
    if args[:1] == ['diff']: print(os.environ['TEST_DIFF'])
if name == 'sudo':
    if args[0] == '-n': args = args[1:]
    os.environ['UNDER_SUDO'] = '1'
    os.execvp(args[0], args)
if name == 'docker':
    if args == ['info'] and os.environ.get('NEEDS_SUDO') == '1' and not os.environ.get('UNDER_SUDO'):
        sys.exit(1)
    failure = os.environ.get('FAILURE')
    if failure == 'pull' and args == ['compose', 'pull']: sys.exit(1)
    if failure == 'health' and args[:2] == ['compose', 'up']: sys.exit(1)
'''
            for name in ('git', 'pnpm', 'docker', 'sudo', 'systemctl'):
                path = root / 'bin' / name
                path.write_text(f'#!{sys.executable}\n' + stub)
                path.chmod(0o755)
            log = root / 'calls.jsonl'
            env = {**os.environ, 'PATH': str(root / 'bin') + ':' + os.environ['PATH'],
                   'CALL_LOG': str(log), 'TEST_DIFF': diff, 'FAILURE': failure,
                   'NEEDS_SUDO': str(int(needs_sudo))}
            result = subprocess.run(['bash', str(root / 'scripts/deploy.sh')],
                                    env=env, capture_output=True, text=True)
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            return result, calls

    def test_no_git_diff_still_pulls_and_reconciles_without_forced_restart(self):
        result, calls = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['docker', 'compose', 'pull'], calls)
        up = next(c for c in calls if c[:3] == ['docker', 'compose', 'up'])
        self.assertNotIn('--force-recreate', up)
        self.assertIn('--wait', up)
        self.assertIn('never', up)  # The completed pull determines the image.
        self.assertLess(calls.index(['docker', 'compose', 'pull']), calls.index(up))

    def test_bind_mount_change_forces_recreation(self):
        for diff in ('searxng/settings.yml', 'searxng/gateway.py', 'scripts/deploy-searxng.sh'):
            with self.subTest(diff=diff):
                result, calls = self.run_deploy(diff=diff)
                self.assertEqual(result.returncode, 0, result.stderr)
                up = next(c for c in calls if c[:3] == ['docker', 'compose', 'up'])
                self.assertIn('--force-recreate', up)

    def test_pull_failure_keeps_running_container_but_updates_other_apps_and_fails_deploy(self):
        result, calls = self.run_deploy(diff='apps/nagi_bot_server/src/index.ts', failure='pull')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(any(c[:3] == ['docker', 'compose', 'up'] for c in calls))
        self.assertIn(['systemctl', 'restart', 'nagi-bot.service'], calls)
        self.assertNotIn('Deployment completed', result.stdout)

    def test_unhealthy_update_is_not_reported_as_success(self):
        result, _ = self.run_deploy(failure='health')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('Deployment completed', result.stdout)

    def test_missing_env_is_not_silently_skipped(self):
        result, calls = self.run_deploy(missing_env=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn(['docker', 'compose', 'pull'], calls)

    def test_production_user_can_use_noninteractive_sudo(self):
        result, calls = self.run_deploy(needs_sudo=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(['sudo', '-n', 'docker', 'compose', 'pull'], calls)


if __name__ == '__main__':
    unittest.main()
